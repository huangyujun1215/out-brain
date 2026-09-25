FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable \
    && (corepack prepare pnpm@11.22.0 --activate || (sleep 3 && corepack prepare pnpm@11.22.0 --activate) || (sleep 8 && corepack prepare pnpm@11.22.0 --activate))
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/api/package.json apps/api/tsconfig*.json ./apps/api/
COPY apps/api/prisma/schema.prisma ./apps/api/prisma/schema.prisma
RUN pnpm install --frozen-lockfile --filter @nbboss/api... --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000
COPY apps/api ./apps/api
RUN pnpm --filter @nbboss/contracts build && pnpm --filter @nbboss/api prisma:generate && pnpm --filter @nbboss/api build
EXPOSE 3001
CMD ["sh", "-c", "pnpm --filter @nbboss/api exec prisma migrate deploy && pnpm --filter @nbboss/api start"]
