FROM rust:1.97-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs
RUN cargo build --release

COPY src ./src
RUN touch src/main.rs && cargo build --release

# SearXNG supplies Python, its runtime dependencies, and the default non-root user.
FROM searxng/searxng:latest AS runtime
USER root

COPY --from=builder /app/target/release/web-kit /usr/local/bin/web-kit
COPY docker/combined-entrypoint.sh /usr/local/bin/webkit-entrypoint
COPY docker/searxng/settings-render.yml /etc/searxng/settings.yml

RUN chmod 0755 /usr/local/bin/web-kit /usr/local/bin/webkit-entrypoint \
    && chown -R searxng:searxng /etc/searxng /usr/local/bin/web-kit /usr/local/bin/webkit-entrypoint

ENV WEBKIT_BIND_ADDR=0.0.0.0:10000 \
    WEBKIT_SEARXNG_URL=http://127.0.0.1:8081 \
    WEBKIT_MAX_BODY_BYTES=5242880 \
    WEBKIT_MAX_REDIRECTS=5 \
    WEBKIT_REQUEST_TIMEOUT_MS=12000 \
    RUST_LOG=web_kit=info,tower_http=info \
    SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml

USER searxng
EXPOSE 10000
ENTRYPOINT ["/usr/local/bin/webkit-entrypoint"]
