# syntax=docker/dockerfile:1
# Suma compute-plane image (infra/README.md): the per-user Fly Machine's
# rootfs. Ubuntu 24.04 user environment + suma-agent, per PRD §7.
#
# Build from the REPO ROOT (the cargo workspace is the build context):
#   docker build -f infra/compute-image/Dockerfile -t <ref> .
# or use infra/compute-image/build.sh, which also pushes to registry.fly.io.

# Same pin as the workspace toolchain — agent/Cargo.toml documents why the
# dependency set must stay parseable by Rust 1.79.
FROM rust:1.79-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY agent ./agent
COPY sidecar ./sidecar
COPY services/egressgw ./services/egressgw
RUN cargo build --release -p suma-agent

FROM ubuntu:24.04

# The dev toolchain the target user expects at a terminal (PRD §8.5: Ubuntu
# 24.04, docker, toolchains). Docker-in-VM setup is deferred — Fly Machines
# run our image directly, so nested docker needs its own follow-up.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      htop \
      jq \
      less \
      openssh-client \
      pkg-config \
      python3 \
      ripgrep \
      tmux \
      unzip \
      vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Node 22 + Claude Code, installed globally so a wiped/fresh $HOME volume
# still has them on first boot.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/suma-agent /usr/local/bin/suma-agent

# Root in your own microVM is the honest model (PRD §8.5): $HOME is /root,
# and the Fly volume mounts there so PTY scrollback ($HOME/.suma/pty) and
# ~/cloud survive machine replacement.
ENV HOME=/root
WORKDIR /root

# Defaults; the provider overrides these per machine (fly.ts sets
# SUMA_MACHINE_ID, SUMA_AGENT_LISTEN, SUMA_AGENT_CLAIMS).
ENV SUMA_AGENT_LISTEN=[::]:2222
EXPOSE 2222

ENTRYPOINT ["/usr/local/bin/suma-agent"]
