# Production image (deploy/README.md). Built by .github/workflows/deploy.yml,
# never on the server. One image runs the app, the migrations (prisma CLI) and
# access:sync, so node_modules keeps the dev dependencies.

FROM node:22-bookworm-slim AS base
# Prisma's engines link against OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /app

# Changes only with the lockfile or the schema (postinstall: prisma generate).
FROM base AS deps
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY deploy ./deploy
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3100
CMD ["node", "dist/main"]
