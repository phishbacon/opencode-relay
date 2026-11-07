# Docker Compose deployment

The container is a generic OpenCode notification front door. OpenCode can continue running directly on the Docker host and remain bound only to `127.0.0.1:4096`. Relay uses Docker host networking, connects to that loopback upstream, and binds its own listener only to host loopback.

Relay listens on `127.0.0.1:8080` by default. TLS stays outside this project.

## Configure

From the repository root:

```sh
cp docker/.env.example docker/.env
chmod 600 docker/.env
```

Edit `docker/.env`:

- `OPENCODE_RELAY_PUBLIC_URL`: the **same HTTPS origin users use for OpenCode**, for example `https://ai.example.com`.
- `OPENCODE_RELAY_UPSTREAM_URL`: internal OpenCode origin; normally leave the Docker default `http://127.0.0.1:4096`.
- `OPENCODE_RELAY_VAPID_SUBJECT`: your VAPID contact.
- `OPENCODE_RELAY_TOKEN`: a private random value of at least 32 characters. Configure the OpenCode plugin with the same value.
- `OPENCODE_RELAY_PORT`: Relay's host-loopback port; default is `8080`.

Generate the event token with a password manager or another cryptographically secure random generator. The example value is not a production secret.

## Build and run

```sh
docker compose --env-file docker/.env -f docker/compose.yaml build relay
docker compose --env-file docker/.env -f docker/compose.yaml up -d relay
docker compose --env-file docker/.env -f docker/compose.yaml ps
```

No initialization CLI is required. On first startup the server creates a fresh SQLite database and persistent VAPID keys in the `relay-data` volume.

The health check probes:

```text
http://127.0.0.1:3400/notifications/healthz
```

## External ingress

Point your HTTPS reverse proxy or tunnel at the published front-door port and forward the **entire OpenCode hostname** to it. Do not create special ingress rules for `/notifications`, `/sw.js`, WebSockets, or API paths.

Conceptually:

```text
https://ai.example.com/*  ->  http://127.0.0.1:8080/*
                              Relay front door
                                  |
                                  +-> owned: /sw.js, /notifications, /notifications/*
                                  |
                                  +-> everything else -> OpenCode :4096
```

The Compose file contains no Traefik-, Cloudflare-, or other provider-specific routing labels. Because Relay deliberately binds only host loopback, a containerized ingress cannot reach it directly through a Docker bridge. Route ingress through a host-reachable hop (for example host Traefik/file-provider configuration), or deliberately choose a different networking design rather than exposing OpenCode itself.

## OpenCode plugin

When OpenCode runs on the same host, the plugin can post to the local published front door instead of hairpinning through public ingress:

```text
OPENCODE_RELAY_URL=http://127.0.0.1:8080
OPENCODE_RELAY_TOKEN=<same token as docker/.env>
```

Loopback HTTP is allowed for the plugin. Browser traffic still uses the HTTPS public OpenCode origin.

## Persistence and hardening

Only `/app/data` is persistent and writable. It stores `notifications.sqlite` containing VAPID keys, Web Push subscriptions, and event/execution deduplication records.

The Compose service:

- runs as the unprivileged Node `node` user;
- uses a read-only root filesystem;
- drops all Linux capabilities;
- enables `no-new-privileges`;
- limits PIDs;
- uses a small temporary `/tmp`;
- exposes only one configurable host port;
- persists only the named data volume.

Do not reuse a database from the removed standalone Relay/PWA architecture. Its schema is intentionally rejected; start with a new `relay-data` volume/database for the front door.

## Back up and restore

Stop the front door before filesystem-level backup so SQLite is closed cleanly, then copy the whole data directory rather than only the main database file:

```sh
docker compose --env-file docker/.env -f docker/compose.yaml stop relay
docker cp "$(docker compose --env-file docker/.env -f docker/compose.yaml ps -aq relay)":/app/data ./relay-data-backup
docker compose --env-file docker/.env -f docker/compose.yaml start relay
```

Protect the backup: it contains the VAPID private key and active push subscriptions.

To restore, stop Relay, replace the contents of the persistent data volume with a known-good complete backup, preserve ownership for the container's `node` user, then start Relay again. Keep an independent backup before any destructive restore.

## Upgrade and verification

Use an immutable image tag for releases and retain the previous tested image. Before deploying a new image:

```sh
pnpm check
docker compose --env-file docker/.env -f docker/compose.yaml build relay
docker compose --env-file docker/.env -f docker/compose.yaml up -d relay
docker compose --env-file docker/.env -f docker/compose.yaml ps
```

Then verify normal OpenCode HTTP navigation, streaming/WebSocket behavior, `/sw.js` augmentation, `/notifications` enrollment, and a real push notification. The reference deployment has also passed physical iPhone background-delivery and exact-session-opening validation.
