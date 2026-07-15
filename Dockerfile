# Single-stage: the bot runs TypeScript directly via tsx (same convention as
# the messenger server), so dev deps ARE the runtime. ~100MB image, fine for
# a personal bot.
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 4002
USER node

# PORT is configurable, but the healthcheck probes the default; override
# HEALTHCHECK (or ignore it) if you change PORT.
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4002/healthz || exit 1

CMD ["npx", "tsx", "src/index.ts"]
