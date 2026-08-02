FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY flue.config.ts vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/jobseeker.db \
    OPENAI_CODEX_AUTH_FILE=/app/auth/auth.json \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npx playwright install --with-deps --only-shell chromium && \
    npm cache clean --force && \
    chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY fonts ./fonts

RUN mkdir -p /app/data /app/auth && \
    chown -R node:node /app && \
    chmod 700 /app/data /app/auth
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.mjs"]
