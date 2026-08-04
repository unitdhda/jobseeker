FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
COPY vite.config.ts tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS production-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=production-deps /app/node_modules ./node_modules
RUN rm -rf node_modules/@myriaddreamin node_modules/@earendil-works node_modules/pdfjs-dist node_modules/mammoth node_modules/unpdf
COPY package.json ./
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["bun", "dist/server.mjs"]

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS worker
WORKDIR /app
ENV NODE_ENV=production PORT=3000 OPENAI_CODEX_AUTH_FILE=/app/auth/auth.json PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=production-deps /app/node_modules ./node_modules
COPY package.json ./
RUN bun node_modules/playwright/cli.js install --with-deps --only-shell chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY fonts ./fonts
# /app/data must exist and be bun-owned in the image so a mounted named volume inherits that ownership;
# deployments that persist HH browser state there otherwise get EACCES as a root-owned volume.
RUN mkdir -p /app/auth /app/data && chown -R bun:bun /app && chmod 700 /app/auth /app/data
USER bun
CMD ["bun", "dist/task-worker.mjs"]
