# Toolchain image only. Engine source is bind-mounted at run time and never COPYed.
FROM rust:1.96.1-bookworm

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    binutils \
    ca-certificates \
    clang \
    cmake \
    g++ \
    gcc \
    git \
    make \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
