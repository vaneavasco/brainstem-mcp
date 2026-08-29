# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ARG CLOUDFLARED_VERSION=2026.8.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}" -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared && cloudflared --version
WORKDIR /app
COPY --from=build /app/dist/tunnel ./dist/tunnel
USER node
CMD ["node", "dist/tunnel/supervisor-main.js"]
