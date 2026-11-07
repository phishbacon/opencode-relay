# OpenCode Relay

Transparent notification front door for OpenCode V2. OpenCode itself stays unmodified: the front door proxies the normal OpenCode site and owns only the notification integration routes plus an augmented copy of OpenCode's service worker.

> **Status:** Experimental. Automated proxy, WebSocket, service-worker, push, plugin, and cross-package tests pass. Physical iPhone testing has also confirmed background delivery and exact-session opening from a notification tap.

See [front-door configuration and API](docs/backend.md), [notification enrollment](docs/notifications.md), and [Docker deployment](docker/README.md).

## Architecture

- `packages/server` is the single browser-facing front door.
- `/sw.js`, `/notifications`, and `/notifications/*` are handled by Relay.
- Every other HTTP route and WebSocket upgrade is proxied to OpenCode unchanged.
- `/sw.js` is fetched from OpenCode dynamically and receives one marked notification integration block; Relay does not replace OpenCode's worker.
- `packages/plugin` listens for root-session completion/failure events and POSTs them to `/notifications/api/events` with a shared Bearer token.
- Push payloads contain only a generic outcome, event tag, and exact OpenCode session URL. Prompts, responses, directories, and session titles are not included.
- VAPID keys, browser subscriptions, and event/execution deduplication are persisted in SQLite.

Install **OpenCode at the configured public origin** as the Home Screen app.

## Workspace

| Path | Purpose |
| --- | --- |
| `packages/plugin` | OpenCode V2 event-source plugin |
| `packages/server` | Transparent OpenCode proxy and notification front door |
| `docker` | Hardened container and generic Compose deployment |
| `tests` | Cross-package integration and workspace tests |

## Example setup

This example keeps OpenCode on `127.0.0.1:4096`, runs Relay on `127.0.0.1:8080`, and points the public HTTPS OpenCode hostname at Relay. Relay then proxies ordinary OpenCode traffic while owning the notification routes and service-worker augmentation.

### 1. Install and build

```sh
git clone <repository-url> opencode-relay
cd opencode-relay
pnpm install
pnpm check
```

### 2. Configure the Relay front door

Create the Docker environment file:

```sh
cp docker/.env.example docker/.env
chmod 600 docker/.env
```

Edit `docker/.env` with values for your deployment:

```dotenv
OPENCODE_RELAY_PUBLIC_URL=https://ai.example.com
OPENCODE_RELAY_UPSTREAM_URL=http://127.0.0.1:4096
OPENCODE_RELAY_VAPID_SUBJECT=mailto:admin@example.com
OPENCODE_RELAY_TOKEN=<same-random-secret-used-by-the-plugin>
OPENCODE_RELAY_PORT=8080
```

Use a cryptographically random token of at least 32 characters. The Relay server and OpenCode plugin must use the same value.

Start Relay:

```sh
docker compose --env-file docker/.env -f docker/compose.yaml build relay
docker compose --env-file docker/.env -f docker/compose.yaml up -d relay
docker compose --env-file docker/.env -f docker/compose.yaml ps
```

### 3. Put Relay in front of OpenCode

Point your HTTPS reverse proxy or tunnel at Relay, not directly at OpenCode:

```text
https://ai.example.com/* -> http://127.0.0.1:8080/* -> Relay -> http://127.0.0.1:4096
```

Forward the entire hostname. Do not split `/notifications`, `/sw.js`, API, or WebSocket paths into separate ingress rules.

### 4. Load the OpenCode V2 plugin

Build the plugin:

```sh
pnpm --filter @opencode-relay/plugin build
```

Then add the local plugin to `opencode.jsonc`. Point it at Relay's local loopback URL so completion events do not need to leave the host:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-relay/packages/plugin",
      "options": {
        "relayURL": "http://127.0.0.1:8080",
        "token": "<same-random-secret-used-by-the-relay>"
      }
    }
  ]
}
```

For production, keep the shared token out of version control; use your normal OpenCode secret/file substitution mechanism or environment configuration rather than committing it in plaintext.

### 5. Enable notifications on iPhone/iPad

1. Open `https://ai.example.com` and install the normal OpenCode site to the Home Screen.
2. Open `https://ai.example.com/notifications` from that installed PWA.
3. Enter the existing OpenCode password if prompted.
4. Select **Enable notifications** and grant notification permission.
5. Complete an OpenCode root-session run, background the PWA, and confirm the notification arrives. Tapping it should open the exact originating OpenCode session.

The notification page uses the existing OpenCode origin and root-scoped service worker.

## Development

Requires Node.js 22.12+ and pnpm 10.

```sh
pnpm install
pnpm check
```

`pnpm check` runs TypeScript checks, all tests, and package builds.

## OpenCode V2 plugin

Build `packages/plugin` with:

```sh
pnpm --filter @opencode-relay/plugin build
```

Load the package using OpenCode V2's `plugins` configuration. Configure either plugin options or equivalent environment variables:

- `relayURL` / `OPENCODE_RELAY_URL`: base URL of the front door. HTTPS is required except for loopback HTTP.
- `token` / `OPENCODE_RELAY_TOKEN`: the same secret configured on the front door. Use at least 32 random characters and keep it out of version control.

The plugin posts to `/notifications/api/events`. It filters child sessions, deduplicates event/execution identities in memory, retries transient failures, reconnects a dropped event stream, and reconciles recent persisted root-session outcomes. The front door also persists event/execution deduplication so plugin reloads cannot replay an already accepted outcome.
