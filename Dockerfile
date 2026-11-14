ARG BUN_VERSION=1.3.9

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/
# Bundled into the binary for install-host.
COPY host/ host/

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64 ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun build --compile --target="$target" --outfile=/threadslop src/index.ts

FROM debian:bookworm-slim AS runtime

# OpenSSH refuses to run for a uid without a passwd entry, so the user is real.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 threadslop \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin threadslop \
    && mkdir /data \
    && chown threadslop:threadslop /data \
    && chmod 700 /data

COPY --from=builder /threadslop /usr/local/bin/threadslop

ENV DATA_DIR=/data
# bun resolves TZ through its bundled ICU, so the image needs no tzdata.
ENV TZ=Asia/Tokyo

USER 10001:10001
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/threadslop"]
