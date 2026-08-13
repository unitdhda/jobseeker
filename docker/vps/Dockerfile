FROM node:24-slim

ENV NODE_ENV=production \
    HOME=/app/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH=/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin

WORKDIR /app

# The reference image installs the pinned published package; it never compiles the checkout.
COPY package.json ./package.json
RUN npm install --omit=dev --ignore-scripts=false \
    && npm cache clean --force

# Deployment-owned extensions are copied as data/code. Their dependencies are isolated here.
COPY extensions/ ./extensions/
RUN if [ -f ./extensions/package.json ]; then \
      npm install --prefix ./extensions --omit=dev --ignore-scripts=false; \
    fi \
    && if node -e "require.resolve('playwright/package.json', { paths: ['/app/extensions'] })" 2>/dev/null; then \
      npx --prefix ./extensions playwright install --with-deps chromium; \
    fi \
    && mkdir -p /app/data /ms-playwright \
    && chmod -R a+rX /ms-playwright \
    && chown -R node:node /app/data /app/extensions

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["jobseeker"]
CMD ["start"]
