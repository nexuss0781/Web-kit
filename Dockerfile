FROM rust:1.97-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs
RUN cargo build --release

COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /nonexistent --shell /usr/sbin/nologin webkit

COPY --from=builder /app/target/release/web-kit /usr/local/bin/web-kit
USER webkit
EXPOSE 8080
ENV RUST_LOG=web_kit=info,tower_http=info
CMD ["/usr/local/bin/web-kit"]
