FROM node:24-bookworm-slim AS build
RUN corepack enable \
    && (corepack prepare pnpm@11.22.0 --activate || (sleep 3 && corepack prepare pnpm@11.22.0 --activate) || (sleep 8 && corepack prepare pnpm@11.22.0 --activate))
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
RUN pnpm install --frozen-lockfile --filter @nbboss/web... --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN pnpm --filter @nbboss/contracts build && pnpm --filter @nbboss/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
