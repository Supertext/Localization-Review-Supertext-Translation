# Supertext translation proxy (apps/proxy) — production image (Railway). Build from the repo root.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/proxy/package.json apps/proxy/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/proxy apps/proxy
RUN npm run build --workspace apps/proxy

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
# The standalone build keeps the monorepo layout: apps/proxy/server.js next to a pruned node_modules.
COPY --from=build --chown=node:node /repo/apps/proxy/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/proxy/.next/static ./apps/proxy/.next/static
COPY --from=build --chown=node:node /repo/apps/proxy/public ./apps/proxy/public
# The app bundles postgres into its chunks; the migration script needs the package itself (no dependencies).
COPY --from=build --chown=node:node /repo/node_modules/postgres ./node_modules/postgres
COPY --from=build --chown=node:node /repo/apps/proxy/migrations ./apps/proxy/migrations
COPY --from=build --chown=node:node /repo/apps/proxy/scripts/migrate.mjs ./apps/proxy/scripts/migrate.mjs
COPY --from=build --chown=node:node /repo/apps/proxy/src/lib/db-url.mjs ./apps/proxy/src/lib/db-url.mjs
USER node
EXPOSE 8080
# Migrations first (creates REVIEW_DB_NAME on a shared server if needed), then the app.
CMD ["sh", "-c", "node apps/proxy/scripts/migrate.mjs && exec node apps/proxy/server.js"]
