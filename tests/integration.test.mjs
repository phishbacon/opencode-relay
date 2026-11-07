import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import plugin from "../packages/plugin/dist/index.js"
import { loadConfig, sessionLink } from "../packages/server/dist/config.js"
import { createApp } from "../packages/server/dist/index.js"
import { Store } from "../packages/server/dist/store.js"

const directory = mkdtempSync("/tmp/opencode/relay-integration-")
after(() => rmSync(directory, { recursive: true, force: true }))
const token = "integration-test-plugin-credential-at-least-32-characters"
let databaseIndex = 0

function keys(authByte = 2) {
  const p256dh = Buffer.alloc(65, 1)
  p256dh[0] = 4
  return {
    p256dh: p256dh.toString("base64url"),
    auth: Buffer.alloc(16, authByte).toString("base64url"),
  }
}

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/integration", authByte = 2) {
  return { endpoint, keys: keys(authByte) }
}

async function eventually(predicate, timeout = 3500) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for notification integration")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class EventStream {
  constructor(options) {
    this.events = []
    this.waiters = []
    this.closed = false
    options.signal.addEventListener("abort", () => this.close(), { once: true })
  }

  [Symbol.asyncIterator]() { return this }

  next() {
    if (this.events.length) return Promise.resolve({ value: this.events.shift(), done: false })
    if (this.closed) return Promise.resolve({ done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  emit(event) {
    if (this.closed) throw new Error("cannot emit to closed stream")
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.events.push(event)
  }

  close() {
    this.closed = true
    for (const resolve of this.waiters.splice(0)) resolve({ done: true })
  }
}

async function serverHarness(t, send) {
  const database = join(directory, `integration-${++databaseIndex}.sqlite`)
  const config = loadConfig({
    OPENCODE_RELAY_PUBLIC_URL: "https://ai.example.test",
    OPENCODE_RELAY_UPSTREAM_URL: "http://127.0.0.1:4096",
    OPENCODE_RELAY_VAPID_SUBJECT: "mailto:relay@example.test",
    OPENCODE_RELAY_TOKEN: token,
    OPENCODE_RELAY_DB: database,
  })
  const store = new Store(database)
  const { server, delivery } = createApp(config, store, send)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await delivery.drain()
    await new Promise((resolve) => server.close(resolve))
    store.close()
  })
  return { base, config, store, delivery }
}

test("OpenCode plugin feeds the front door and produces exact-session privacy-minimal pushes", async (t) => {
  const sent = []
  const h = await serverHarness(t, async (_subscription, body) => {
    sent.push(JSON.parse(body))
  })
  h.store.putSubscription(subscription())

  const unauthorized = await fetch(`${h.base}/notifications/api/events`, {
    method: "POST",
    headers: {
      authorization: "Bearer invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      eventId: "unauthorized",
      sessionId: "root",
      outcome: "succeeded",
      created: Date.now(),
      directory: "/projects/relay",
    }),
  })
  assert.equal(unauthorized.status, 401)

  const time = Date.now()
  const sessions = new Map([
    ["root", {
      id: "root",
      title: "Private root title",
      location: { directory: "/projects/relay" },
      outcome: "succeeded",
      time: { idle: time },
    }],
    ["failure", {
      id: "failure",
      title: "Private failure title",
      location: { directory: "/projects/relay" },
      outcome: "failed",
      time: { idle: time + 1 },
    }],
    ["child", {
      id: "child",
      parentID: "root",
      title: "Private child title",
      location: { directory: "/projects/relay" },
      outcome: "succeeded",
      time: { idle: time + 2 },
    }],
  ])
  const streams = []
  const ctx = {
    options: { relayURL: h.base, token },
    location: { directory: "/projects/relay", workspaceID: "integration-workspace" },
    session: {
      get: async ({ sessionID }) => sessions.get(sessionID),
      list: async () => ({ data: [], cursor: {} }),
    },
    event: {
      subscribe(options) {
        const stream = new EventStream(options)
        streams.push(stream)
        return stream
      },
    },
  }

  const cleanup = plugin.setup(ctx)
  assert.equal(typeof cleanup, "function")
  try {
    await eventually(() => streams.length === 1)
    const emit = (id, sessionID, type) => streams[0].emit({
      id,
      type,
      created: time,
      location: ctx.location,
      data: { sessionID, error: { message: "secret failure detail" } },
    })

    emit("completion", "root", "session.execution.succeeded")
    emit("failure-event", "failure", "session.execution.failed")
    emit("child-event", "child", "session.execution.succeeded")

    await eventually(() => sent.length === 2)
    await h.delivery.drain()

    assert.deepEqual(new Set(sent.map((message) => message.title)), new Set([
      "OpenCode completed",
      "OpenCode failed",
    ]))
    assert.deepEqual(new Set(sent.map((message) => message.url)), new Set([
      sessionLink(h.config, "root"),
      sessionLink(h.config, "failure"),
    ]))
    for (const message of sent) {
      const serialized = JSON.stringify(message)
      assert.equal(message.body, undefined)
      assert.ok(!serialized.includes("/projects/relay"))
      assert.ok(!serialized.includes("Private"))
      assert.ok(!serialized.includes("secret failure detail"))
    }

    emit("completion", "root", "session.execution.succeeded")
    emit("same-execution-new-event", "root", "session.execution.succeeded")
    await new Promise((resolve) => setTimeout(resolve, 75))
    await h.delivery.drain()
    assert.equal(sent.length, 2)
  } finally {
    await cleanup()
  }
})
