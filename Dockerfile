# STAGE 0 - Building
FROM node:22.8.0 AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# STAGE 1 - Runtime
FROM node:22.8.0-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY assets/ ./assets/
COPY --from=build /app/dist ./dist/

EXPOSE 8080
CMD ["node", "/app/dist/index.js"]
