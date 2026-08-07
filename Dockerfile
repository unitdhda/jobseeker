FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS worker
WORKDIR /app
ENV NODE_ENV=production PORT=3000 OPENAI_CODEX_AUTH_FILE=/app/auth/auth.json PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./
# Extensions carry their own runtime dependencies (playwright for hh); the app itself ships none of them.
COPY extensions ./extensions
RUN cd extensions && bun install && \
    bun node_modules/playwright/cli.js install --with-deps --only-shell chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/packages/app/dist ./dist
COPY fonts ./fonts
# /app/data must exist and be bun-owned in the image so a mounted named volume inherits that ownership;
# deployments that persist HH browser state there otherwise get EACCES as a root-owned volume.
RUN mkdir -p /app/auth /app/data && chown -R bun:bun /app && chmod 700 /app/auth /app/data
USER bun
CMD ["bun", "dist/server.mjs"]
