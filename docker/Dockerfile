ARG NODE_IMAGE=node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN npm install --global pnpm@10.34.9
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @opencode-relay/server build
# pnpm 10's non-injected workspace deploy requires --legacy. The server has
# no workspace runtime dependencies; this produces an isolated prod node_modules.
RUN pnpm --filter @opencode-relay/server deploy --prod --legacy /out/server

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3400 \
    OPENCODE_RELAY_DB=/app/data/notifications.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /out/server ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3400
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT || 3400}/notifications/healthz`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "dist/index.js"]
