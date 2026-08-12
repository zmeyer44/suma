# Control-plane image (services/control) for Railway — see infra/README.md.
# Build context is the REPO ROOT (the pnpm workspace); Railway is pointed at
# this file via the service variable RAILWAY_DOCKERFILE_PATH.
FROM node:22-slim

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# The workspace, as uploaded (gitignore-filtered: no node_modules, no .env).
COPY . .

# Control plus its workspace deps (@suma/protocol, @suma/config) only —
# the desktop app and the rest of the monorepo are not this image's problem.
#
# --ignore-scripts: the control plane runs via tsx from source and needs no
# postinstall, but a plain workspace install runs lifecycle scripts for other
# projects it pulls in — notably node-pty (from apps/desktop's terminal), a
# native module that needs python/make/g++ this slim image lacks. Skipping
# scripts keeps the build hermetic; esbuild/tsx resolve their platform binary
# from optionalDependencies, not the postinstall.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@suma/control..."

ENV NODE_ENV=production
WORKDIR /app/services/control
# Railway injects PORT; server.ts reads it (default 8787).
CMD ["pnpm", "start"]
