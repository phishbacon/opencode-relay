import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { generateVAPIDKeys } from "web-push"

export interface Subscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

type SubscriptionRow = { endpoint: string; p256dh: string; auth: string }

function subscription(row: SubscriptionRow): Subscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
}

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000")
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
    if (version > 1) {
      throw new Error("Legacy Relay database detected. Configure a fresh OPENCODE_RELAY_DB for the notification front door.")
    }
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE subscriptions (
            endpoint TEXT PRIMARY KEY,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE events (
            event_id TEXT PRIMARY KEY,
            execution_key TEXT UNIQUE,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX events_created_at_idx ON events(created_at);
          PRAGMA user_version=1;
        `)
      })
    }
  }

  close(): void { this.db.close() }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private setting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)
  }

  vapidKeys(): { publicKey: string; privateKey: string } {
    return this.transaction(() => {
      const publicKey = this.setting("vapid_public")
      const privateKey = this.setting("vapid_private")
      if (publicKey && privateKey) return { publicKey, privateKey }
      if (publicKey || privateKey) throw new Error("Incomplete VAPID credentials")
      const keys = generateVAPIDKeys()
      this.setSetting("vapid_public", keys.publicKey)
      this.setSetting("vapid_private", keys.privateKey)
      return keys
    })
  }

  putSubscription(value: Subscription): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO subscriptions(endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at
    `).run(value.endpoint, value.keys.p256dh, value.keys.auth, now, now)
  }

  removeSubscription(value: Subscription): boolean {
    return this.db.prepare("DELETE FROM subscriptions WHERE endpoint=? AND p256dh=? AND auth=?")
      .run(value.endpoint, value.keys.p256dh, value.keys.auth).changes > 0
  }

  removeExpiredSubscription(value: Subscription): void {
    this.removeSubscription(value)
  }

  recipients(): Subscription[] {
    const rows = this.db.prepare("SELECT endpoint,p256dh,auth FROM subscriptions ORDER BY created_at")
      .all() as unknown as SubscriptionRow[]
    return rows.map(subscription)
  }

  canDeliver(value: Subscription): boolean {
    return !!this.db.prepare("SELECT 1 FROM subscriptions WHERE endpoint=? AND p256dh=? AND auth=?")
      .get(value.endpoint, value.keys.p256dh, value.keys.auth)
  }

  acceptEvent(eventId: string, executionKey?: string): boolean {
    return this.transaction(() => {
      const now = Date.now()
      this.db.prepare("DELETE FROM events WHERE created_at<?").run(now - 7 * 86400_000)
      const duplicate = this.db.prepare(`
        SELECT 1 FROM events WHERE event_id=? OR (execution_key IS NOT NULL AND execution_key=?)
      `).get(eventId, executionKey ?? null)
      if (duplicate) return false
      this.db.prepare("INSERT INTO events(event_id,execution_key,created_at) VALUES(?,?,?)")
        .run(eventId, executionKey ?? null, now)
      return true
    })
  }
}
