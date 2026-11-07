import { Plugin } from "@opencode/plugin"
import { setTimeout as sleep } from "node:timers/promises"

type Context = Plugin.Context
type Outcome = "succeeded" | "failed"
const EVENT_TYPES = ["session.execution.succeeded", "session.execution.failed"] as const
type RelayEvent = {
  id: string
  created: number
  type: (typeof EVENT_TYPES)[number]
  location?: { directory: string; workspaceID?: string }
  data: { sessionID: string }
}
type Session = Awaited<ReturnType<Context["session"]["get"]>>

const MAX_QUEUE = 64
const CONCURRENCY = 4
const MAX_SEEN = 2048
const MAX_RECOVERY_AGE = 5 * 60_000
const STREAM_TIMEOUT = 90_000
const REQUEST_TIMEOUT = 5_000

interface Notification {
  eventId: string
  sessionId: string
  outcome: Outcome
  created: number
  directory: string
  title?: string
  executionKey?: string
  reconciled?: true
}

function remember(cache: Set<string>, key: string): boolean {
  if (cache.has(key)) return false
  cache.add(key)
  if (cache.size > MAX_SEEN) cache.delete(cache.values().next().value!)
  return true
}

function locationMatches(ctx: Context, directory: string, workspaceID?: string): boolean {
  if (directory !== ctx.location.directory) return false
  // Session metadata only exposes a directory; event locations can also identify a workspace.
  return workspaceID === undefined || workspaceID === ctx.location.workspaceID
}

function executionKey(session: Session, outcome: Outcome, created?: number): string | undefined {
  if (!session.time.idle || session.outcome !== outcome) return undefined
  // A newer run can finish before a queued event is read. Do not attach that
  // newer run's identity to the older event.
  if (created !== undefined &&
      (session.time.idle < created - 1_000 || session.time.idle > created + 15_000)) return undefined
  return `${session.id}:${outcome}:${session.time.idle}`
}

function endpointFor(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || !raw.trim()) return
  try {
    const url = new URL(raw)
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username || url.password || url.search || url.hash) return
    return new URL("/notifications/api/events", url)
  } catch {
    return
  }
}

function log(message: string): void {
  console.warn(`[opencode-relay] ${message}`)
}

function start(ctx: Context, endpoint: URL, token: string): Plugin.Cleanup {
  const stop = new AbortController()
  const queue: Array<() => Promise<void>> = []
  const active = new Set<Promise<void>>()
  const recovery = new Set<Promise<void>>()
  const seenEvents = new Set<string>()
  const seenExecutions = new Set<string>()
  let busy = 0

  function pump(): void {
    while (!stop.signal.aborted && busy < CONCURRENCY && queue.length) {
      const task = queue.shift()!
      busy++
      const work = task()
        .catch((error: unknown) => {
          if (!stop.signal.aborted) log(`notification dropped: ${String(error)}`)
        })
        .finally(() => {
          busy--
          active.delete(work)
          pump()
        })
      active.add(work)
    }
  }

  function enqueue(id: string, task: () => Promise<void>): void {
    if (stop.signal.aborted || seenEvents.has(id)) return
    if (queue.length >= MAX_QUEUE) {
      log("event queue full; event discarded (recovery may find its final outcome)")
      return
    }
    remember(seenEvents, id)
    queue.push(task)
    pump()
  }

  async function deliver(notification: Notification): Promise<void> {
    for (let attempt = 0; attempt < 3 && !stop.signal.aborted; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(notification),
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
        })
        if (response.ok) return
        if (response.status !== 408 && response.status !== 429 && response.status < 500) {
          throw new Error(`permanent HTTP ${response.status}`)
        }
        if (attempt === 2) throw new Error(`HTTP ${response.status} after 3 attempts`)
      } catch (error) {
        if (stop.signal.aborted) return
        if (error instanceof Error && error.message.startsWith("permanent HTTP ")) throw error
        if (attempt === 2) throw new Error("request failed after 3 attempts", { cause: error })
      }
      await sleep(250 * 4 ** attempt, undefined, { signal: stop.signal })
    }
  }

  async function notify(session: Session, eventId: string, outcome: Outcome, created: number, reconciled = false): Promise<void> {
    if (session.parentID || !locationMatches(ctx, session.location.directory)) return
    const key = executionKey(session, outcome, reconciled ? undefined : created)
    if (key && !remember(seenExecutions, key)) return
    await deliver({
      eventId,
      sessionId: session.id,
      outcome,
      created,
      directory: session.location.directory,
      ...(session.title && { title: session.title }),
      ...(key && { executionKey: key }),
      ...(reconciled && { reconciled: true }),
    })
  }

  function accept(event: RelayEvent): void {
    if (event.location && !locationMatches(ctx, event.location.directory, event.location.workspaceID)) return
    enqueue(event.id, async () => {
      const session = await ctx.session.get(
        { sessionID: event.data.sessionID },
        { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) },
      )
      const outcome = event.type === "session.execution.succeeded" ? "succeeded" : "failed"
      await notify(session, event.id, outcome, event.created)
    })
  }

  async function reconcile(since: number): Promise<void> {
    // OpenCode streams are volatile. Reconstruct only the latest persisted outcome,
    // not a history of individual executions, and cap both age and page count.
    const minimum = Math.max(since - 1_000, Date.now() - MAX_RECOVERY_AGE)
    let cursor: string | undefined
    for (let page = 0; page < 3 && !stop.signal.aborted; page++) {
      const result = await ctx.session.list(
        { directory: ctx.location.directory, parentID: null, order: "desc", limit: 100, cursor },
        { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]) },
      )
      for (const session of result.data) {
        const outcome = session.outcome
        if ((outcome !== "succeeded" && outcome !== "failed") ||
            !session.time.idle || session.time.idle < minimum ||
            session.parentID || !locationMatches(ctx, session.location.directory)) continue
        const id = `recovery:${session.id}:${outcome}:${session.time.idle}`
        enqueue(id, () => notify(session, id, outcome, session.time.idle!, true))
      }
      cursor = result.cursor.next ?? undefined
      if (!cursor) break
    }
  }

  function scheduleRecovery(since: number): void {
    if (recovery.size) return
    const work = reconcile(since)
      .catch((error: unknown) => {
        if (!stop.signal.aborted) log(`reconciliation failed: ${String(error)}`)
      })
      .finally(() => recovery.delete(work))
    recovery.add(work)
  }

  async function run(): Promise<void> {
    let previousStart = Date.now()
    let backoff = 1_000
    let initial = true
    while (!stop.signal.aborted) {
      const stream = new AbortController()
      const signal = AbortSignal.any([stop.signal, stream.signal])
      let activity = Date.now()
      const started = activity
      const watchdog = setInterval(() => {
        if (Date.now() - activity > STREAM_TIMEOUT) stream.abort()
      }, 10_000)
      try {
        // Start consumption immediately; scan recent session outcomes concurrently
        // so an event emitted during the scan is still delivered by the stream.
        const events = ctx.event.subscribe({
          types: [...EVENT_TYPES],
          signal,
          onActivity: () => { activity = Date.now() },
        })
        scheduleRecovery(initial ? started - 60_000 : previousStart)
        initial = false
        for await (const event of events) {
          activity = Date.now()
          if (stop.signal.aborted) break
          accept(event)
        }
      } catch (error) {
        if (!stop.signal.aborted && !stream.signal.aborted) log(`event stream disconnected: ${String(error)}`)
      } finally {
        clearInterval(watchdog)
        stream.abort()
      }
      previousStart = started
      if (Date.now() - started > 30_000) backoff = 1_000
      try {
        await sleep(backoff, undefined, { signal: stop.signal })
      } catch {
        break
      }
      backoff = Math.min(backoff * 2, 30_000)
    }
  }

  const listener = run().catch((error: unknown) => {
    if (!stop.signal.aborted) log(`listener stopped: ${String(error)}`)
  })
  return async () => {
    stop.abort()
    queue.length = 0
    await Promise.allSettled([listener, ...active, ...recovery])
  }
}

export default Plugin.define({
  id: "opencode-relay",
  setup(ctx) {
    // OpenCode's server URL identifies OpenCode, not the independently hosted relay.
    const relayURL = typeof ctx.options.relayURL === "string"
      ? ctx.options.relayURL
      : process.env.OPENCODE_RELAY_URL
    const token = typeof ctx.options.token === "string"
      ? ctx.options.token
      : process.env.OPENCODE_RELAY_TOKEN
    const endpoint = endpointFor(relayURL)
    if (!endpoint || !token) {
      log("disabled: configure relayURL/token plugin options or OPENCODE_RELAY_URL/OPENCODE_RELAY_TOKEN")
      return
    }
    return start(ctx, endpoint, token)
  },
})
