FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev \
    && npx playwright install --with-deps chromium

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
COPY templates/resume/main.tex ./templates/resume/main.tex

RUN npm run build \
    && OPENAPPLY_RUN_BROWSER_E2E=1 npx vitest run test/hosted-pre-submit-preview.e2e.test.ts \
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
CMD ["node", "/app/dist/src/cloud/cloud-browser-task-cli.js"]
