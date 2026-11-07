# Notification front door

The server is a TypeScript HTTP/WebSocket reverse proxy backed by SQLite for notification state. It sits in front of an existing OpenCode V2 server: Relay owns only the notification integration routes and proxies everything else to OpenCode.

## Configuration

| Environment variable | Meaning |
| --- | --- |
| `OPENCODE_RELAY_PUBLIC_URL` | Required browser-facing OpenCode origin, for example `https://ai.example.com`. HTTPS is required except for loopback development. |
| `OPENCODE_RELAY_UPSTREAM_URL` | Internal OpenCode origin. Defaults to `http://127.0.0.1:4096`; Docker defaults it to `http://host.docker.internal:4096`. |
| `OPENCODE_RELAY_VAPID_SUBJECT` | Required VAPID contact, such as `mailto:admin@example.com` or an HTTPS URL. |
| `OPENCODE_RELAY_TOKEN` | Required shared plugin Bearer token, 32–4096 characters. |
| `OPENCODE_RELAY_DB` | SQLite file. Defaults to `data/notifications.sqlite`; Docker uses `/app/data/notifications.sqlite`. |
| `HOST` | Listener address. Defaults to `127.0.0.1`; the container uses `0.0.0.0` internally. |
| `PORT` | Listener port. Defaults to `3400`. |

The public URL is also used to derive OpenCode's server key and exact session destination:

```text
/server/<base64url(public-origin)>/session/<session-id>
```

For example, a public origin of `https://ai.example.com` produces notification links on that same origin. No configurable deep-link template is used.

## Owned routes

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET/HEAD /sw.js` | OpenCode's normal access policy | Fetch upstream OpenCode worker and append Relay's push/click integration |
| `GET/HEAD /notifications` | Page itself is public | Notification enrollment/status page |
| `GET/HEAD /notifications/app.js` | Public | Enrollment client |
| `GET /notifications/healthz` | Public | Container/front-door health |
| `GET /notifications/api/config` | Existing OpenCode Basic auth | Return VAPID public key |
| `PUT /notifications/api/subscription` | Existing OpenCode Basic auth + same-origin write | Register/replace current browser subscription |
| `DELETE /notifications/api/subscription` | Existing OpenCode Basic auth + same-origin write | Remove current browser subscription |
| `POST /notifications/api/events` | `Authorization: Bearer <plugin token>` | Accept a plugin outcome event |

All other HTTP requests and WebSocket upgrades are forwarded to `OPENCODE_RELAY_UPSTREAM_URL` by the front door.

The browser notification APIs do not maintain a separate Relay account. Relay verifies the supplied OpenCode Authorization header by requesting upstream `/api/info`. If the browser does not already send that header to the notification route, the enrollment page asks for the existing OpenCode password and keeps the derived Basic Authorization value only in page memory.

Browser writes require `Origin` to equal `OPENCODE_RELAY_PUBLIC_URL`. Subscription endpoints are limited to the known Apple, Google, and Mozilla Web Push services, and subscription keys are structurally validated before storage.

## Service worker and notification clicks

Relay fetches OpenCode's current `/sw.js` on each request and appends one marked integration block. The upstream worker remains intact.

Push payloads contain only:

- `title`: `OpenCode completed` or `OpenCode failed`
- `url`: exact same-origin OpenCode session route
- `tag`: event ID

The service worker rejects notification destinations that are cross-origin or do not match the expected exact-session route. On a notification tap it focuses an already-open exact session when possible, otherwise navigates an existing same-origin OpenCode window, otherwise opens the exact session URL.

## Persistence and delivery

SQLite stores only VAPID settings, endpoint-keyed push subscriptions, and accepted event/execution IDs. A fresh database is created automatically. Databases from the removed standalone Relay schema are deliberately not migrated; use a new database path/volume for this architecture.

Event IDs and execution keys are retained for seven days for replay suppression. Push delivery is bounded and best-effort; expired 404/410 subscriptions are removed and transient failures are retried. There is no durable notification delivery queue after HTTP `202`.

Run the server tests with:

```sh
pnpm --filter @opencode-relay/server test
pnpm check
```
