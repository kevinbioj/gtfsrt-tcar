FROM node:22.14.0 AS base
RUN corepack enable

# ---

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .
RUN pnpm install --frozen-lockfile

COPY ./src/ .
COPY tsconfig.json .
RUN pnpm build

# ---

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ ./dist

COPY ./assets/ ./dist

EXPOSE 8080
CMD ["node", "/app/dist/index.js"]
