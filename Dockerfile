# Browser preview of InvoiceApp.
#
# This image serves the real renderer over HTTP against a preview-only SQLite
# database. It is NOT the desktop app: PDF export and the local-model assistant
# both need Electron and a native llama.cpp runtime, and neither is present here.
#
# Three stages, for three different dependency sets:
#   deps    — runtime node_modules only, with better-sqlite3 compiled for Node
#   builder — dev dependencies, used once to produce preview/dist
#   runtime — slim, non-root, carries the output of the other two
#
# node-llama-cpp is deliberately dropped from every stage. The preview never
# runs a model, and the package pulls hundreds of megabytes of prebuilt binaries.

# ---------------------------------------------------------------------------
ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------------------
# deps — production dependencies for the server
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# better-sqlite3 ships prebuilt binaries but falls back to compiling from source;
# these are the fallback's toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# `postinstall` in package.json rebuilds better-sqlite3 for Electron's ABI. There
# is no Electron here, and `resolveNativeBinding()` in src/db/client.ts already
# falls back to the plain Node build when the Electron one is absent.
RUN npm pkg delete dependencies.node-llama-cpp \
    && npm pkg delete scripts.postinstall \
    && npm install --omit=dev --no-audit --no-fund \
    # tsx is a dev dependency of the repo but a runtime one for the preview
    # server, which is TypeScript. Pinned to the same major the repo uses.
    && npm install --no-save --no-audit --no-fund tsx@^4.20.7 \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# builder — the web bundle
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: this stage only runs tsc and vite, neither of which loads a
# native addon, so nothing needs to be compiled and node-llama-cpp's installer
# never runs.
RUN npm pkg delete dependencies.node-llama-cpp \
    && npm install --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.node.json tsconfig.web.json ./
COPY src ./src
COPY preview ./preview

RUN npx tsc --noEmit -p preview/tsconfig.json \
    && npx vite build --config preview/vite.config.ts

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PREVIEW_HOST=0.0.0.0 \
    PREVIEW_PORT=4300 \
    PREVIEW_DB_PATH=/app/preview-data/preview.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
# The domain code, the contract and the migrations. The preview imports these
# directly — that is the whole point: no forked copy of the business logic.
COPY src/shared ./src/shared
COPY src/domain ./src/domain
COPY src/db ./src/db
COPY preview/server.ts preview/handlers.ts preview/seed.ts ./preview/
COPY preview/raw-loader.mjs preview/register-raw.mjs ./preview/
COPY preview/download ./preview/download
COPY preview/landing ./preview/landing
COPY --from=builder /app/preview/dist ./preview/dist

# `node` (uid 1000) ships with the official image; the app never runs as root.
RUN mkdir -p /app/preview-data && chown -R node:node /app/preview-data
USER node

VOLUME ["/app/preview-data"]
EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PREVIEW_PORT||4300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "--import", "./preview/register-raw.mjs", "preview/server.ts"]
