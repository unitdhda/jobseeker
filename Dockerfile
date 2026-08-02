FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM production-deps AS web
ENV NODE_ENV=production PORT=3000
RUN rm -rf node_modules/@myriaddreamin node_modules/@earendil-works node_modules/pdfjs-dist node_modules/mammoth node_modules/unpdf
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.mjs"]

FROM production-deps AS worker
ENV NODE_ENV=production PORT=3000 OPENAI_CODEX_AUTH_FILE=/app/auth/auth.json PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps --only-shell chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist ./dist
COPY fonts ./fonts
RUN mkdir -p /app/auth && chown -R node:node /app && chmod 700 /app/auth
USER node
CMD ["node", "dist/task-worker.mjs"]
