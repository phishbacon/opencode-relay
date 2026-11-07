import { setTimeout as sleep } from "node:timers/promises"
import * as webPush from "web-push"
import type { Config } from "./config.js"
import { sessionLink } from "./config.js"
import type { Store, Subscription } from "./store.js"

export interface RelayEvent {
  eventId: string
  sessionId: string
  outcome: "succeeded" | "failed"
  created: number
  directory: string
  title?: string
  executionKey?: string
  reconciled?: true
}

export type PushSend = (subscription: Subscription, body: string) => Promise<unknown>

export function webPushSender(config: Config, store: Store): PushSend {
  const keys = store.vapidKeys()
  webPush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey)
  return (subscription, body) => webPush.sendNotification(subscription, body, {
    TTL: 60, timeout: 5000, urgency: "normal",
  })
}

export class PushDelivery {
  private queue: RelayEvent[] = []
  private running = 0
  private readonly active = new Set<Promise<void>>()
  private readonly concurrency = 4
  private readonly maxQueue = 64

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly send: PushSend,
  ) {}

  get full(): boolean { return this.queue.length >= this.maxQueue }

  enqueue(event: RelayEvent): void {
    this.queue.push(event)
    this.pump()
  }

  async drain(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active])
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const event = this.queue.shift()!
      this.running++
      const task = this.deliver(event)
        .catch((error: unknown) => console.warn("[opencode-relay] push delivery failed:", String(error)))
        .finally(() => {
          this.running--
          this.active.delete(task)
          this.pump()
        })
      this.active.add(task)
    }
  }

  private async deliver(event: RelayEvent): Promise<void> {
    const payload = JSON.stringify({
      title: event.outcome === "succeeded" ? "OpenCode completed" : "OpenCode failed",
      url: sessionLink(this.config, event.sessionId),
      tag: event.eventId,
    })
    const recipients = this.store.recipients()
    let index = 0
    const workers = Array.from({ length: Math.min(4, recipients.length) }, async () => {
      while (index < recipients.length) {
        const recipient = recipients[index++]
        if (recipient) await this.sendToSubscription(recipient, payload)
      }
    })
    await Promise.all(workers)
  }

  private async sendToSubscription(subscription: Subscription, payload: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.store.canDeliver(subscription)) return
      try {
        await this.send(subscription, payload)
        return
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          this.store.removeExpiredSubscription(subscription)
          return
        }
        if (attempt === 2 || (status !== undefined && status !== 408 && status !== 429 && status < 500)) {
          console.warn(`[opencode-relay] push rejected for ${new URL(subscription.endpoint).hostname} (HTTP ${status ?? "network"})`)
          return
        }
        await sleep(250 * 4 ** attempt)
      }
    }
  }
}
