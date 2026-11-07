import { resolve } from "node:path"

export interface Config {
  port: number
  host: string
  databasePath: string
  publicURL: URL
  upstreamURL: URL
  vapidSubject: string
  eventToken: string
}

function endpoint(raw: string, label: string, publicFacing = false): URL {
  const url = new URL(raw)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      (publicFacing && url.protocol !== "https:" && !loopback) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${label} must be an HTTP(S) origin without credentials, path, query or hash`)
  }
  return url
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3400)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT")
  const host = env.HOST ?? "127.0.0.1"
  if (!env.OPENCODE_RELAY_PUBLIC_URL) throw new Error("Set OPENCODE_RELAY_PUBLIC_URL")
  const publicURL = endpoint(env.OPENCODE_RELAY_PUBLIC_URL, "OPENCODE_RELAY_PUBLIC_URL", true)
  const upstreamURL = endpoint(env.OPENCODE_RELAY_UPSTREAM_URL ?? "http://127.0.0.1:4096", "OPENCODE_RELAY_UPSTREAM_URL")
  if (publicURL.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Insecure public HTTP requires a loopback listener")
  }
  const vapidSubject = env.OPENCODE_RELAY_VAPID_SUBJECT
  if (!vapidSubject || !(vapidSubject.startsWith("mailto:") || vapidSubject.startsWith("https:"))) {
    throw new Error("Set OPENCODE_RELAY_VAPID_SUBJECT to mailto:address or an HTTPS URL")
  }
  const eventToken = env.OPENCODE_RELAY_TOKEN
  if (!eventToken || eventToken.length < 32 || eventToken.length > 4096) {
    throw new Error("Set OPENCODE_RELAY_TOKEN to a secret of at least 32 characters")
  }
  return {
    port,
    host,
    databasePath: resolve(env.OPENCODE_RELAY_DB ?? "data/notifications.sqlite"),
    publicURL,
    upstreamURL,
    vapidSubject,
    eventToken,
  }
}

export function serverKey(config: Config): string {
  return Buffer.from(config.publicURL.origin, "utf8").toString("base64url")
}

export function sessionLink(config: Config, sessionId: string): string {
  return new URL(`/server/${serverKey(config)}/session/${encodeURIComponent(sessionId)}`, config.publicURL).toString()
}
