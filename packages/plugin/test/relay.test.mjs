import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../dist/index.js"

const directory = "/projects/relay"

class Stream {
  constructor(options) {
    this.options = options
    this.events = []
    this.waiting = []
    this.closed = false
    options.signal.addEventListener("abort", () => this.close(), { once: true })
  }

  [Symbol.asyncIterator]() {
    return this
  }

  next() {
    if (this.events.length) return Promise.resolve({ value: this.events.shift(), done: false })
    if (this.closed) return Promise.resolve({ done: true })
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  emit(event) {
    if (this.closed) throw new Error("cannot emit to closed stream")
    this.options.onActivity?.()
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.events.push(event)
  }

  close() {
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter({ done: true })
  }
}

function makeSession(id, overrides = {}) {
  return {
    id,
    location: { directory },
    title: `Session ${id}`,
    outcome: "succeeded",
    time: { idle: Date.now(), created: Date.now() - 20_000, updated: Date.now() },
    ...overrides,
  }
}

function event(id, sessionID, type = "session.execution.succeeded", location = { directory, workspaceID: "work-a" }) {
  return {
    id,
    type,
    created: Date.now(),
    data: { sessionID, error: { message: "confidential failure details" } },
    location,
  }
}

function harness(sessions = []) {
  const streams = []
  const byID = new Map(sessions.map((value) => [value.id, value]))
  const ctx = {
    location: { directory, workspaceID: "work-a" },
    options: { serverURL: "http://localhost:3400" },
    session: {
      get: async ({ sessionID }) => {
        if (!byID.has(sessionID)) throw new Error("missing session")
        return byID.get(sessionID)
      },
      list: async () => ({ data: [], cursor: {} }),
    },
    event: {
      subscribe: (options) => {
        const stream = new Stream(options)
        streams.push(stream)
        return stream
      },
    },
  }
  return { ctx, streams, byID }
}

async function until(predicate, timeout = 3500) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for assertion")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function configure(t, fetcher) {
  const before = {
    token: process.env.OPENCODE_RELAY_TOKEN,
    url: process.env.OPENCODE_RELAY_URL,
    fetch: globalThis.fetch,
  }
  process.env.OPENCODE_RELAY_TOKEN = "test-server-issued-token"
  process.env.OPENCODE_RELAY_URL = "http://localhost:3400"
  globalThis.fetch = fetcher
  t.after(() => {
    if (before.token === undefined) delete process.env.OPENCODE_RELAY_TOKEN
    else process.env.OPENCODE_RELAY_TOKEN = before.token
    if (before.url === undefined) delete process.env.OPENCODE_RELAY_URL
    else process.env.OPENCODE_RELAY_URL = before.url
    globalThis.fetch = before.fetch
  })
}

test("forwards root completion and failure without leaking error details", async (t) => {
  const calls = []
  configure(t, async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) })
    return new Response(null, { status: 204 })
  })
  const h = harness([
    makeSession("root"),
    makeSession("failure", { outcome: "failed" }),
    makeSession("child", { parentID: "root" }),
    makeSession("other", { location: { directory: "/other" } }),
  ])
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => h.streams.length > 0)
  const stream = h.streams[0]
  assert.deepEqual(stream.options.types, ["session.execution.succeeded", "session.execution.failed"])
  stream.emit(event("e-root", "root"))
  stream.emit(event("e-failed", "failure", "session.execution.failed"))
  stream.emit(event("e-child", "child"))
  stream.emit(event("e-other", "other", "session.execution.succeeded", undefined))
  stream.emit(event("e-wrong-workspace", "root", "session.execution.succeeded", {
    directory, workspaceID: "work-b",
  }))
  await until(() => calls.length === 2)
  assert.deepEqual(new Set(calls.map((call) => call.body.outcome)), new Set(["succeeded", "failed"]))
  for (const call of calls) {
    assert.equal(call.url, "http://localhost:3400/notifications/api/events")
    assert.equal(call.init.headers.authorization, "Bearer test-server-issued-token")
    assert.equal(call.body.directory, directory)
    assert.ok(call.body.executionKey)
    assert.ok(!JSON.stringify(call.body).includes("confidential"))
  }
})

test("deduplicates repeated event IDs and executions", async (t) => {
  const posted = []
  configure(t, async (_url, init) => {
    posted.push(JSON.parse(init.body))
    return new Response(null, { status: 200 })
  })
  const h = harness([makeSession("root")])
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => h.streams.length > 0)
  h.streams[0].emit(event("one", "root"))
  h.streams[0].emit(event("one", "root"))
  h.streams[0].emit(event("different-event-same-execution", "root"))
  await until(() => posted.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(posted.length, 1)
})

test("reconciles recent root outcomes with bounded pagination", async (t) => {
  const posted = []
  configure(t, async (_url, init) => {
    posted.push(JSON.parse(init.body))
    return new Response(null, { status: 204 })
  })
  const h = harness()
  const recent = makeSession("recent", { time: { idle: Date.now() - 5_000 } })
  const old = makeSession("old", { time: { idle: Date.now() - 120_000 } })
  let pageCount = 0
  h.ctx.session.list = async ({ cursor }) => {
    pageCount++
    if (!cursor) return { data: [recent, old], cursor: { next: "second" } }
    return { data: [makeSession("child", { parentID: "parent" })], cursor: {} }
  }
  h.byID.set(recent.id, recent)
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => posted.length === 1)
  assert.equal(posted[0].reconciled, true)
  assert.equal(posted[0].sessionId, "recent")
  assert.equal(posted[0].created, recent.time.idle)
  assert.equal(pageCount, 2)
  h.streams[0].emit({ ...event("live-for-same-execution", recent.id), created: recent.time.idle })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(posted.length, 1)
})

test("reconnects a finished event stream and recovers missed outcomes", async (t) => {
  const posted = []
  configure(t, async (_url, init) => {
    posted.push(JSON.parse(init.body))
    return new Response(null, { status: 200 })
  })
  const h = harness()
  let current = []
  h.ctx.session.list = async () => ({ data: current, cursor: {} })
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => h.streams.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  h.streams[0].close()
  current = [makeSession("offline")]
  await until(() => h.streams.length === 2, 3000)
  await until(() => posted.length === 1)
  assert.equal(posted[0].sessionId, "offline")
  assert.equal(posted[0].reconciled, true)
})

test("retries transient HTTP failures but not permanent authorization failures", async (t) => {
  const responses = [503, 429, 204, 401]
  const posted = []
  configure(t, async (_url, init) => {
    posted.push(JSON.parse(init.body))
    return new Response(null, { status: responses.shift() })
  })
  const h = harness([makeSession("ok"), makeSession("unauthorized")])
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => h.streams.length > 0)
  h.streams[0].emit(event("retry", "ok"))
  await until(() => posted.length === 3, 4000)
  assert.ok(posted.every((value) => value.eventId === "retry"))
  h.streams[0].emit(event("no-retry", "unauthorized"))
  await until(() => posted.length === 4)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(posted.length, 4)
})

test("cleanup aborts outstanding delivery and rejects new events", async (t) => {
  const requests = []
  configure(t, (_url, init) => {
    requests.push(init)
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
    })
  })
  const h = harness([makeSession("root")])
  const cleanup = plugin.setup(h.ctx)
  await until(() => h.streams.length > 0)
  h.streams[0].emit(event("in-flight", "root"))
  await until(() => requests.length === 1)
  await cleanup()
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(h.streams[0].closed, true)
  assert.equal(requests.length, 1)
})

test("rejects insecure remote endpoints without subscribing", async (t) => {
  configure(t, async () => { throw new Error("unexpected fetch") })
  const h = harness()
  process.env.OPENCODE_RELAY_URL = "http://public.example.org"
  const cleanup = plugin.setup(h.ctx)
  assert.equal(cleanup, undefined)
  assert.equal(h.streams.length, 0)
})

test("always targets configured relay rather than OpenCode's server URL", async (t) => {
  const destinations = []
  configure(t, async (url) => {
    destinations.push(String(url))
    return new Response(null, { status: 204 })
  })
  process.env.OPENCODE_RELAY_URL = "https://relay.example.org"
  const h = harness([makeSession("root")])
  h.ctx.options.serverURL = "https://opencode.example.org"
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => h.streams.length > 0)
  h.streams[0].emit(event("to-relay", "root"))
  await until(() => destinations.length === 1)
  assert.deepEqual(destinations, ["https://relay.example.org/notifications/api/events"])
})

test("plugin options configure relay without process environment", async (t) => {
  const calls = []
  configure(t, async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization })
    return new Response(null, { status: 204 })
  })
  delete process.env.OPENCODE_RELAY_URL
  delete process.env.OPENCODE_RELAY_TOKEN
  const h = harness([makeSession("root")])
  h.ctx.options.relayURL = "http://127.0.0.1:18080"
  h.ctx.options.token = "option-token"
  const cleanup = plugin.setup(h.ctx)
  t.after(cleanup)
  await until(() => h.streams.length > 0)
  h.streams[0].emit(event("options", "root"))
  await until(() => calls.length === 1)
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:18080/notifications/api/events",
    authorization: "Bearer option-token",
  }])
})

test("missing relay URL disables forwarding even if OpenCode has a server URL", (t) => {
  configure(t, async () => { throw new Error("unexpected fetch") })
  delete process.env.OPENCODE_RELAY_URL
  const h = harness()
  assert.equal(plugin.setup(h.ctx), undefined)
  assert.equal(h.streams.length, 0)
})
