# Identity egress gateway (services/egressgw) for Fly — see
# docs/egress-spike.md for the Phase-0 spike this image exists for.
# Build context is the REPO ROOT; the sibling Dockerfile.dockerignore
# allowlists just the cargo workspace.
#
# rust:1.79 matches the workspace toolchain (the blake3 =1.5.5 pin in
# services/egressgw/Cargo.toml exists because newer releases need a newer
# compiler — keep these in step).
FROM rust:1.79-slim AS build

WORKDIR /src
COPY . .
RUN cargo build --release -p suma-egressgw --bins

FROM debian:bookworm-slim

# The gateway makes plain outbound TCP and terminates no TLS, so the runtime
# image needs nothing but the binaries and an unprivileged user.
RUN useradd --system --no-create-home egressgw
COPY --from=build /src/target/release/suma-egressgw /usr/local/bin/suma-egressgw
COPY --from=build /src/target/release/mint-egress-token /usr/local/bin/mint-egress-token
USER egressgw

# startup.rs refuses to serve without SUMA_EGRESS_TOKEN_SECRET (fly secret)
# unless the loopback-only dev opt-in is set — there is no insecure default.
EXPOSE 8443
CMD ["suma-egressgw"]
