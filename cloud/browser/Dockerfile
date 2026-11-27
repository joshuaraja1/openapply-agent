FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    OPENAPPLY_TECTONIC_BIN=/usr/local/bin/tectonic \
    OPENAPPLY_TECTONIC_CACHE=/opt/tectonic-cache \
    OPENAPPLY_PRIVATE_WORK_ROOT=/work

# Official Tectonic release, pinned by its published SHA-256 digest. The
# cache is warmed at build time and becomes read-only for browser tasks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --silent --show-error \
      'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz' \
      --output /tmp/tectonic.tar.gz \
    && echo '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7  /tmp/tectonic.tar.gz' | sha256sum --check \
    && tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
    && rm /tmp/tectonic.tar.gz

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev \
    && npx playwright install --with-deps chromium

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
COPY templates/resume/main.tex ./templates/resume/main.tex

RUN mkdir -p /opt/tectonic-cache /tmp/tectonic-warm \
    && XDG_CACHE_HOME=/opt/tectonic-cache TECTONIC_CACHE_DIR=/opt/tectonic-cache \
      /usr/local/bin/tectonic --untrusted --outdir /tmp/tectonic-warm templates/resume/main.tex \
    && rm -rf /tmp/tectonic-warm

RUN npm run build \
    && OPENAPPLY_RUN_BROWSER_E2E=1 npx vitest run test/hosted-pre-submit-preview.e2e.test.ts \
    && npx vitest run test/local-tectonic-renderer.test.ts \
    && chmod -R a-w /opt/tectonic-cache \
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
