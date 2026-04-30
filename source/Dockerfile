# syntax=docker/dockerfile:1

# Stage 1: Build static assets
FROM node:20-alpine AS static
WORKDIR /build
COPY ts/package.json ts/package-lock.json ./ts/
RUN cd ts && npm ci
COPY prestatic ./prestatic
COPY ts ./ts
RUN mkdir -p /build/static && \
    cp -r prestatic/. /build/static/ && \
    cd ts && \
    npx tsc --build tsconfig.json && \
    npx rollup -c && \
    rm src/*.js

# Stage 2: Build static Rust binary
FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY --from=static /build/static ./static
ENV STATIC_DIR=/build/static
ENV RUSTFLAGS="-C target-feature=+crt-static"
RUN cargo build --release && \
    cp target/release/app /app

# Stage 3: Scratch image with just the binary
FROM scratch
COPY --from=builder /app /app
EXPOSE 8080
ENTRYPOINT ["/app"]
