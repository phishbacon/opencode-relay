import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import HttpProxy from "http-proxy"
import { loadConfig, type Config } from "./config.js"
import { PushDelivery, webPushSender, type PushSend, type RelayEvent } from "./push.js"
import { digest, equalDigest } from "./security.js"
import { Store, type Subscription } from "./store.js"
import { notificationAppJS, notificationHTML, serviceWorkerIntegration, serviceWorkerNavigationBypass } from "./web.js"

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  })
  response.end(body === undefined ? "" : JSON.stringify(body))
}

function text(response: ServerResponse, status: number, body: string, type: string, method = "GET"): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": type.startsWith("text/html")
      ? "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
      : "default-src 'none'",
  })
  response.end(method === "HEAD" ? undefined : body)
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Expected application/json")
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > 16_384) throw new HttpError(413, "Request too large")
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }
  catch { throw new HttpError(400, "Invalid JSON") }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, "Invalid " + field)
  return value
}

function relayEvent(value: unknown): RelayEvent {
  if (!record(value)) throw new HttpError(400, "Expected event object")
  const eventId = requiredString(value.eventId, "eventId", 200)
  const sessionId = requiredString(value.sessionId, "sessionId", 200)
  const directory = requiredString(value.directory, "directory", 2000)
  if (value.outcome !== "succeeded" && value.outcome !== "failed") throw new HttpError(400, "Invalid outcome")
  const created = value.created
  if (typeof created !== "number" || !Number.isSafeInteger(created) ||
      created > Date.now() + 5 * 60_000 || created < Date.now() - 10 * 60_000) {
    throw new HttpError(400, "Event timestamp outside acceptance window")
  }
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 200)) {
    throw new HttpError(400, "Invalid title")
  }
  if (value.executionKey !== undefined) requiredString(value.executionKey, "executionKey", 500)
  if (value.reconciled !== undefined && value.reconciled !== true) throw new HttpError(400, "Invalid reconciliation flag")
  return {
    eventId, sessionId, directory, outcome: value.outcome, created,
    ...(value.title !== undefined && { title: value.title as string }),
    ...(value.executionKey !== undefined && { executionKey: value.executionKey as string }),
    ...(value.reconciled === true && { reconciled: true }),
  }
}

export function parseSubscription(value: unknown): Subscription {
  if (!record(value) || !record(value.keys)) throw new HttpError(400, "Invalid push subscription")
  const endpoint = requiredString(value.endpoint, "endpoint", 2048)
  let url: URL
  try { url = new URL(endpoint) }
  catch { throw new HttpError(400, "Invalid push endpoint") }
  const allowed = new Set([
    "web.push.apple.com",
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
  ])
  if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.port ||
      url.username || url.password || url.hash) throw new HttpError(400, "Unsupported push endpoint")
  const p256dh = requiredString(value.keys.p256dh, "p256dh", 200)
  const auth = requiredString(value.keys.auth, "auth", 100)
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth) ||
      Buffer.from(p256dh, "base64url").length !== 65 ||
      Buffer.from(p256dh, "base64url")[0] !== 4 ||
      Buffer.from(auth, "base64url").length !== 16) {
    throw new HttpError(400, "Malformed subscription keys")
  }
  return { endpoint, keys: { p256dh, auth } }
}

async function requireOpenCodeAuth(request: IncomingMessage, config: Config): Promise<void> {
  const authorization = request.headers.authorization
  if (!authorization) throw new HttpError(401, "OpenCode authentication required")
  let response: Response
  try {
    response = await fetch(new URL("/api/info", config.upstreamURL), {
      headers: { authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new HttpError(502, "OpenCode authentication service unavailable")
  }
  if (response.status === 401 || response.status === 403) throw new HttpError(401, "OpenCode authentication failed")
  if (!response.ok) throw new HttpError(502, "OpenCode authentication service unavailable")
}

async function augmentedWorker(config: Config): Promise<string> {
  let response: Response
  try {
    response = await fetch(new URL("/sw.js", config.upstreamURL), {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new HttpError(502, "OpenCode service worker unavailable")
  }
  if (!response.ok) throw new HttpError(502, "OpenCode service worker unavailable")
  const upstream = await response.text()
  const navigationMarker = "/* opencode-relay:notification-navigation-bypass:v1 */"
  const marker = "/* opencode-relay:notification-integration:v1 */"
  const worker = upstream.includes(navigationMarker) ? upstream : serviceWorkerNavigationBypass() + upstream
  return worker.includes(marker) ? worker : worker + serviceWorkerIntegration(config)
}

export function createApp(config: Config, store: Store, pushSend: PushSend = webPushSender(config, store)) {
  const delivery = new PushDelivery(config, store, pushSend)
  const expectedEventToken = digest(config.eventToken)
  const proxy = HttpProxy.createProxyServer({
    target: config.upstreamURL.origin,
    ws: true,
    changeOrigin: false,
    xfwd: true,
    ignorePath: false,
  })

  proxy.on("error", (error, _request, response) => {
    console.warn("[opencode-relay] upstream proxy failed:", String(error))
    if ("writeHead" in response) {
      const httpResponse = response as ServerResponse
      if (!httpResponse.headersSent) json(httpResponse, 502, { error: "OpenCode upstream unavailable" })
      else httpResponse.destroy()
    } else {
      response.destroy()
    }
  })

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET"
    const requestURL = new URL(request.url ?? "/", config.publicURL)
    const pathname = requestURL.pathname
    try {
      if ((method === "GET" || method === "HEAD") && pathname === "/sw.js") {
        const worker = await augmentedWorker(config)
        text(response, 200, worker, "text/javascript; charset=utf-8", method)
        return
      }

      if ((method === "GET" || method === "HEAD") && (pathname === "/notifications" || pathname === "/notifications/")) {
        text(response, 200, notificationHTML, "text/html; charset=utf-8", method)
        return
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/notifications/app.js") {
        text(response, 200, notificationAppJS, "text/javascript; charset=utf-8", method)
        return
      }
      if (method === "GET" && pathname === "/notifications/healthz") {
        json(response, 200, { status: "ok" })
        return
      }

      if (method === "POST" && pathname === "/notifications/api/events") {
        const header = request.headers.authorization
        const bearer = header?.startsWith("Bearer ") ? header.slice(7) : ""
        if (!bearer || !equalDigest(digest(bearer), expectedEventToken)) throw new HttpError(401, "Unauthorized")
        const event = relayEvent(await readJSON(request))
        if (delivery.full) throw new HttpError(503, "Notification capacity exhausted")
        if (!store.acceptEvent(event.eventId, event.executionKey)) {
          json(response, 200, { duplicate: true })
          return
        }
        delivery.enqueue(event)
        json(response, 202, { accepted: true })
        return
      }

      if (pathname.startsWith("/notifications/api/")) {
        await requireOpenCodeAuth(request, config)
        if (method !== "GET" && method !== "HEAD" && request.headers.origin !== config.publicURL.origin) {
          throw new HttpError(403, "Invalid origin")
        }
        if (method === "GET" && pathname === "/notifications/api/config") {
          json(response, 200, { vapidPublicKey: store.vapidKeys().publicKey })
          return
        }
        if ((method === "PUT" || method === "DELETE") && pathname === "/notifications/api/subscription") {
          const value = parseSubscription(await readJSON(request))
          if (method === "PUT") store.putSubscription(value)
          else store.removeSubscription(value)
          json(response, 204)
          return
        }
        throw new HttpError(404, "Not found")
      }

      if (pathname.startsWith("/notifications/")) throw new HttpError(404, "Not found")
      proxy.web(request, response)
    } catch (error) {
      if (error instanceof HttpError) json(response, error.status, { error: error.message })
      else {
        console.error("[opencode-relay] request failed:", error)
        json(response, 500, { error: "Internal server error" })
      }
    }
  })

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", config.publicURL).pathname
    if (pathname === "/sw.js" || pathname === "/notifications" || pathname.startsWith("/notifications/")) {
      socket.destroy()
      return
    }
    proxy.ws(request, socket, head)
  })

  return { server, delivery, proxy }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const store = new Store(config.databasePath)
  store.vapidKeys()
  const { server, delivery, proxy } = createApp(config, store)
  server.listen(config.port, config.host, () => {
    console.log("[opencode-relay] front door listening on " + config.host + ":" + config.port + "; upstream " + config.upstreamURL.origin)
  })
  const shutdown = () => {
    server.close(() => {
      delivery.drain().finally(() => {
        store.close()
        process.exitCode = 0
      })
    })
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(String(error))
    process.exitCode = 1
  })
}
