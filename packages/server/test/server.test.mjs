import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createServer } from "node:http"
import { connect } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"
import { loadConfig, serverKey, sessionLink } from "../dist/config.js"
import { createApp } from "../dist/index.js"
import { Store } from "../dist/store.js"
import { serviceWorkerIntegration, serviceWorkerNavigationBypass } from "../dist/web.js"

const temp = mkdtempSync("/tmp/opencode/relay-front-door-")
after(() => rmSync(temp, { recursive: true, force: true }))
let sequence = 0
const password = "test-opencode-password"
const eventToken = "event-token-for-tests-with-more-than-32-characters"
const authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64")

function keys(authByte = 2) {
  const publicKey = Buffer.alloc(65, 1)
  publicKey[0] = 4
  return { p256dh: publicKey.toString("base64url"), auth: Buffer.alloc(16, authByte).toString("base64url") }
}

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/test", authByte = 2) {
  return { endpoint, keys: keys(authByte) }
}

function event(overrides = {}) {
  return {
    eventId: "event-1",
    sessionId: "ses_test",
    outcome: "succeeded",
    created: Date.now(),
    directory: "/workspace",
    executionKey: "ses_test:succeeded:1234",
    ...overrides,
  }
}

async function upstream(t) {
  const upgradedSockets = new Set()
  const server = createServer((request, response) => {
    if (request.url === "/api/info") {
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, { "www-authenticate": "Basic realm=\"OpenCode\"" })
        response.end("{}")
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (request.url === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript" })
      response.end("self.__opencodeWorker=true;\n")
      return
    }
    if (request.url?.startsWith("/echo")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        custom: request.headers["x-test-header"],
      }))
      return
    }
    response.writeHead(404)
    response.end("upstream not found")
  })
  server.on("upgrade", (_request, socket) => {
    upgradedSockets.add(socket)
    socket.once("close", () => upgradedSockets.delete(socket))
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
    socket.on("data", (chunk) => socket.write(chunk))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    for (const socket of upgradedSockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  return "http://127.0.0.1:" + server.address().port
}

async function harness(t, sender = async () => undefined) {
  const upstreamURL = await upstream(t)
  const database = join(temp, "case-" + (++sequence) + ".sqlite")
  const config = loadConfig({
    OPENCODE_RELAY_PUBLIC_URL: "https://ai.example.test",
    OPENCODE_RELAY_UPSTREAM_URL: upstreamURL,
    OPENCODE_RELAY_VAPID_SUBJECT: "mailto:test@example.test",
    OPENCODE_RELAY_TOKEN: eventToken,
    OPENCODE_RELAY_DB: database,
  })
  const store = new Store(database)
  const { server, delivery } = createApp(config, store, sender)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = "http://127.0.0.1:" + server.address().port
  t.after(async () => {
    await delivery.drain()
    await new Promise((resolve) => server.close(resolve))
    store.close()
  })
  const request = (path, options = {}) => fetch(base + path, options)
  return { base, config, store, delivery, request }
}

test("configuration derives exact OpenCode session routes", () => {
  const config = loadConfig({
    OPENCODE_RELAY_PUBLIC_URL: "https://ai.example.test",
    OPENCODE_RELAY_VAPID_SUBJECT: "mailto:test@example.test",
    OPENCODE_RELAY_TOKEN: eventToken,
  })
  const expectedKey = Buffer.from("https://ai.example.test").toString("base64url")
  assert.equal(serverKey(config), expectedKey)
  assert.equal(
    sessionLink(config, "ses/a?"),
    "https://ai.example.test/server/" + expectedKey + "/session/ses%2Fa%3F",
  )
})

test("front door owns notification routes and transparently proxies OpenCode HTTP", async (t) => {
  const h = await harness(t)
  const page = await h.request("/notifications")
  assert.equal(page.status, 200)
  assert.match(await page.text(), /OpenCode notifications/)

  const proxied = await h.request("/echo?value=1", {
    headers: {
      authorization,
      cookie: "session=value",
      "x-test-header": "preserved",
    },
  })
  assert.equal(proxied.status, 200)
  assert.deepEqual(await proxied.json(), {
    url: "/echo?value=1",
    authorization,
    cookie: "session=value",
    custom: "preserved",
  })

  const worker = await h.request("/sw.js")
  const workerText = await worker.text()
  assert.match(workerText, /self\.__opencodeWorker=true/)
  assert.equal((workerText.match(/opencode-relay:notification-navigation-bypass:v1/g) ?? []).length, 1)
  assert.equal((workerText.match(/opencode-relay:notification-integration:v1/g) ?? []).length, 1)
  assert.ok(workerText.indexOf("notification-navigation-bypass:v1") < workerText.indexOf("self.__opencodeWorker=true"))
  assert.equal(worker.headers.get("cache-control"), "no-store")
})

test("service worker bypasses OpenCode app-shell routing for notification navigations", async () => {
  const listeners = {}
  const context = {
    URL,
    self: {
      location: { origin: "https://ai.example.test" },
      addEventListener(type, handler) { listeners[type] = handler },
    },
  }
  vm.runInNewContext(serviceWorkerNavigationBypass(), context)

  const request = {
    method: "GET",
    mode: "navigate",
    url: "https://ai.example.test/notifications",
  }
  let responded = false
  let stopped = false
  listeners.fetch({
    request,
    respondWith() { responded = true },
    stopImmediatePropagation() { stopped = true },
  })
  assert.equal(responded, false)
  assert.equal(stopped, true)

  let touched = false
  listeners.fetch({
    request: { ...request, url: "https://ai.example.test/server/test/session/ses_test" },
    respondWith() { touched = true },
    stopImmediatePropagation() { touched = true },
  })
  assert.equal(touched, false)
})

test("front door proxies WebSocket upgrades", async (t) => {
  const h = await harness(t)
  const port = Number(new URL(h.base).port)
  const socket = connect(port, "127.0.0.1")
  t.after(() => socket.destroy())
  let data = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => { data += chunk })
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.write(
    "GET /socket HTTP/1.1\r\n" +
    "Host: ai.example.test\r\n" +
    "Connection: Upgrade\r\n" +
    "Upgrade: websocket\r\n" +
    "Sec-WebSocket-Key: dGVzdA==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n",
  )
  const started = Date.now()
  while (!data.includes("101 Switching Protocols")) {
    if (Date.now() - started > 2000) throw new Error("Timed out waiting for WebSocket upgrade")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  socket.write("relay-ws-proof")
  while (!data.includes("relay-ws-proof")) {
    if (Date.now() - started > 2000) throw new Error("Timed out waiting for proxied WebSocket data")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await new Promise((resolve) => {
    socket.once("close", resolve)
    socket.destroy()
  })
})

test("notification API delegates auth to OpenCode and manages endpoint subscriptions", async (t) => {
  const h = await harness(t)
  assert.equal((await h.request("/notifications/api/config")).status, 401)
  assert.equal((await h.request("/notifications/api/config", {
    headers: { authorization: "Basic invalid" },
  })).status, 401)

  const configResponse = await h.request("/notifications/api/config", { headers: { authorization } })
  assert.equal(configResponse.status, 200)
  assert.ok((await configResponse.json()).vapidPublicKey)

  const first = subscription()
  const missingOrigin = await h.request("/notifications/api/subscription", {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(first),
  })
  assert.equal(missingOrigin.status, 403)

  const headers = {
    authorization,
    origin: h.config.publicURL.origin,
    "content-type": "application/json",
  }
  assert.equal((await h.request("/notifications/api/subscription", {
    method: "PUT", headers, body: JSON.stringify(first),
  })).status, 204)
  assert.deepEqual(h.store.recipients(), [first])

  const rotated = subscription(first.endpoint, 9)
  assert.equal((await h.request("/notifications/api/subscription", {
    method: "PUT", headers, body: JSON.stringify(rotated),
  })).status, 204)
  assert.deepEqual(h.store.recipients(), [rotated])

  assert.equal((await h.request("/notifications/api/subscription", {
    method: "DELETE", headers, body: JSON.stringify(first),
  })).status, 204)
  assert.deepEqual(h.store.recipients(), [rotated])
  assert.equal((await h.request("/notifications/api/subscription", {
    method: "DELETE", headers, body: JSON.stringify(rotated),
  })).status, 204)
  assert.deepEqual(h.store.recipients(), [])

  const untrusted = { ...first, endpoint: "https://127.0.0.1/private" }
  assert.equal((await h.request("/notifications/api/subscription", {
    method: "PUT", headers, body: JSON.stringify(untrusted),
  })).status, 400)
})

test("authenticated events fan out, deduplicate and use privacy-minimal exact-session payloads", async (t) => {
  const sent = []
  const h = await harness(t, async (sub, body) => sent.push({ sub, body: JSON.parse(body) }))
  const first = subscription()
  const second = subscription("https://fcm.googleapis.com/fcm/send/second", 3)
  h.store.putSubscription(first)
  h.store.putSubscription(second)

  const body = JSON.stringify(event())
  assert.equal((await h.request("/notifications/api/events", {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body,
  })).status, 401)
  assert.equal((await h.request("/notifications/api/events", {
    method: "POST",
    headers: { authorization: "Bearer " + eventToken, "content-type": "application/json" },
    body,
  })).status, 202)
  await h.delivery.drain()
  assert.equal(sent.length, 2)
  for (const item of sent) {
    assert.equal(item.body.title, "OpenCode completed")
    assert.equal(item.body.body, undefined)
    assert.equal(item.body.url, sessionLink(h.config, "ses_test"))
    assert.ok(!JSON.stringify(item.body).includes("/workspace"))
  }

  const duplicate = await h.request("/notifications/api/events", {
    method: "POST",
    headers: { authorization: "Bearer " + eventToken, "content-type": "application/json" },
    body,
  })
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).duplicate, true)

  const sameExecution = event({ eventId: "different-id" })
  const executionDuplicate = await h.request("/notifications/api/events", {
    method: "POST",
    headers: { authorization: "Bearer " + eventToken, "content-type": "application/json" },
    body: JSON.stringify(sameExecution),
  })
  assert.equal(executionDuplicate.status, 200)
  assert.equal((await executionDuplicate.json()).duplicate, true)
})

test("stale push endpoints are removed and transient errors retry", async (t) => {
  let attempts = 0
  const h = await harness(t, async () => {
    attempts++
    if (attempts === 1) throw { statusCode: 503 }
    throw { statusCode: 410 }
  })
  h.store.putSubscription(subscription())
  const accepted = await h.request("/notifications/api/events", {
    method: "POST",
    headers: { authorization: "Bearer " + eventToken, "content-type": "application/json" },
    body: JSON.stringify(event()),
  })
  assert.equal(accepted.status, 202)
  await h.delivery.drain()
  assert.equal(attempts, 2)
  assert.deepEqual(h.store.recipients(), [])
})

test("service worker accepts only the configured exact-session route and reuses a same-origin window", async () => {
  const config = loadConfig({
    OPENCODE_RELAY_PUBLIC_URL: "https://ai.example.test",
    OPENCODE_RELAY_VAPID_SUBJECT: "mailto:test@example.test",
    OPENCODE_RELAY_TOKEN: eventToken,
  })
  const listeners = {}
  const notifications = []
  const client = {
    url: "https://ai.example.test/",
    navigated: undefined,
    focused: false,
    async navigate(url) { this.navigated = url; this.url = url; return this },
    async focus() { this.focused = true; return this },
  }
  const context = {
    URL,
    RegExp,
    self: {
      location: { origin: "https://ai.example.test" },
      addEventListener(type, handler) { listeners[type] = handler },
      registration: {
        async showNotification(title, options) { notifications.push({ title, options }) },
      },
      clients: {
        async matchAll() { return [client] },
        async openWindow(url) { throw new Error("unexpected openWindow " + url) },
      },
    },
  }
  vm.runInNewContext(serviceWorkerIntegration(config), context)
  let waiting
  const valid = sessionLink(config, "ses_abc")
  listeners.push({
    data: { json: () => ({ title: "OpenCode completed", url: valid, tag: "one" }) },
    waitUntil(promise) { waiting = promise },
  })
  await waiting
  assert.equal(notifications[0].options.data.url, valid)

  listeners.push({
    data: { json: () => ({ title: "OpenCode failed", url: "https://evil.example/session/x" }) },
    waitUntil(promise) { waiting = promise },
  })
  await waiting
  assert.equal(notifications[1].options.data.url, "https://ai.example.test/")

  listeners.notificationclick({
    notification: { data: { url: valid }, close() {} },
    waitUntil(promise) { waiting = promise },
  })
  await waiting
  assert.equal(client.navigated, valid)
  assert.equal(client.focused, true)
})
