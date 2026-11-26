FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY test ./test
COPY vitest.config.ts ./

RUN npm ci --include=dev \
    && npm run build \
    && npx playwright install --with-deps chromium \
    && npm prune --omit=dev \
    && rm -rf src test dist/test \
    && groupadd --system --gid 10001 openapply \
    && useradd --system --uid 10001 --gid openapply --home-dir /home/openapply --create-home openapply \
    && mkdir -p /work \
    && chown openapply:openapply /work \
    && chmod 0700 /work

USER openapply
ENV HOME=/home/openapply
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/src/cloud/browser-smoke-cli.js"]
