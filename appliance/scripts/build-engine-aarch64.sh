#!/bin/sh
# Build Linux aarch64 switchyard-server on a Linux/macOS host. Never run cargo on the Pi.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ENGINE_PATH=${ENGINE_PATH:-}
OUT_DIR=${OUT_DIR:-"$ROOT/deploy/bin"}
if [ -z "$ENGINE_PATH" ]; then
  ENGINE_PATH=$(awk -F= '/^ENGINE_PATH=/{print $2; exit}' "$ROOT/ENGINE_PIN")
fi
case "$ENGINE_PATH" in
  /*|[A-Za-z]:*) ;;
  *) ENGINE_PATH="$ROOT/$ENGINE_PATH" ;;
esac
ENGINE_PATH=$(CDPATH= cd -- "$ENGINE_PATH" && pwd)
if [ ! -f "$ENGINE_PATH/Cargo.toml" ]; then
  echo "Engine Cargo.toml not found at $ENGINE_PATH" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"
IMAGE=maskclaw-engine-aarch64:1.96.1
docker build --platform linux/arm64 -t "$IMAGE" -f "$ROOT/docker/engine-aarch64.Dockerfile" "$ROOT/docker"
docker run --rm --platform linux/arm64 \
  -e CARGO_TARGET_DIR=/target \
  -v "$ENGINE_PATH:/src:ro" \
  -v maskclaw-engine-target:/target \
  -v maskclaw-engine-cargo-registry:/usr/local/cargo/registry \
  -v maskclaw-engine-cargo-git:/usr/local/cargo/git \
  -v "$OUT_DIR:/out" \
  "$IMAGE" \
  bash -c 'set -eu; export PATH=/usr/local/cargo/bin:$PATH; cargo build --release -p switchyard-server; strip --strip-unneeded /target/release/switchyard-server; install -m 0755 /target/release/switchyard-server /out/switchyard-server'
test -s "$OUT_DIR/switchyard-server"
echo "Wrote $OUT_DIR/switchyard-server"
