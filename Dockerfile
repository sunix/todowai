# Self-hosted image bundling the Rust backend (git2-based git core + HTTP API) with the
# existing web UI's static build output, per the architecture pivot in
# specification/decisions.md (ADR-001) and issue #59. `docker run` against a
# volume-mounted vault folder is meant to be the entire self-hosting story.

FROM node:20-bookworm-slim AS frontend
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

FROM rust:1-bookworm AS backend
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /backend
COPY backend/ ./
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /backend/target/release/todowai-backend ./todowai-backend
COPY --from=frontend /app/dist ./static

ENV TODOWAI_UI_DIR=/app/static
ENV TODOWAI_REPO_PATH=/vault
ENV PORT=8080

EXPOSE 8080
VOLUME ["/vault"]

ENTRYPOINT ["./todowai-backend"]
