# One image per dashboard: docker build -f apps/Dockerfile --build-arg APP=admin .
# The context is the repo root (pnpm workspace); only the chosen app and the
# shared packages are installed and built. Next.js `standalone` output keeps
# the runtime image to the traced files.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Changes only with the lockfile or a workspace manifest.
FROM base AS deps
ARG APP
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json apps/admin/
COPY apps/manager/package.json apps/manager/
COPY packages/api/package.json packages/api/
COPY packages/bff/package.json packages/bff/
COPY packages/ui/package.json packages/ui/
# The app and its workspace dependencies only. No install scripts: the root
# (backend) postinstall would run `prisma generate`, and nothing the
# dashboards use needs a build step.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --ignore-scripts --filter "@jiwar/${APP}..."

FROM deps AS build
ARG APP
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
RUN pnpm --filter "@jiwar/${APP}" build

FROM node:22-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 APP=${APP}
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
USER node
# PORT and JIWAR_API_URL come from the environment (docker-compose.yml).
CMD ["sh", "-c", "exec node apps/$APP/server.js"]
