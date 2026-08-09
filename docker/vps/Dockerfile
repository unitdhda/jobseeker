# Container image for a CLI deployment: the application arrives as the published npm package, and this directory
# supplies only the version pin, the extensions, and the runtime the extensions need.
#
# Build context is the deployment directory, so `package.json` here pins the release and `extensions/` here is
# whatever this deployment runs. Nothing is compiled from a source checkout.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production PORT=3000 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# The version pin lives in the deployment's package.json, so a release is a one-line change plus a rebuild.
COPY package.json ./
RUN npm install --omit=dev

# Extensions carry their own dependencies. Chromium is provisioned only when one of them asks for Playwright, so a
# deployment with API-backed sources alone builds a much smaller image.
COPY extensions ./extensions
RUN cd extensions && \
    if [ -f package.json ]; then npm install --omit=dev; fi && \
    if [ -d node_modules/playwright ]; then \
      npx playwright install --with-deps --only-shell chromium && chmod -R a+rX /ms-playwright; \
    fi

# /app/data must exist and be node-owned in the image so a mounted named volume inherits that ownership;
# deployments that persist browser state there otherwise get EACCES as a root-owned volume.
RUN mkdir -p /app/data && chown -R node:node /app && chmod 700 /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "node_modules/.bin/jobseeker", "start"]
