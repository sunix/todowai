use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use todowai_backend::api;
use todowai_backend::repository::Repository;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // TODOWAI_REPO_PATH is expected to be a Docker volume mount in the self-hosted deployment.
    // Subfolder/vault-access configuration is #60's job, not this scaffold's.
    let repo_path = std::env::var("TODOWAI_REPO_PATH").unwrap_or_else(|_| "/vault".to_string());
    let ui_dir = std::env::var("TODOWAI_UI_DIR").unwrap_or_else(|_| "./static".to_string());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);

    let repository = Repository::open(PathBuf::from(&repo_path).as_path())
        .unwrap_or_else(|err| panic!("failed to open git repository at {repo_path}: {err}"));

    let shared_repository: api::SharedRepository = Arc::new(Mutex::new(repository));

    // Hash-based client-side routing (e.g. `#/settings`) means the browser never requests a
    // deep path from the server for a client route, so a plain static file service is enough —
    // no SPA history-API fallback-to-index.html rewriting is needed.
    let app = api::router(shared_repository)
        .fallback_service(ServeDir::new(&ui_dir))
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(%addr, %repo_path, %ui_dir, "todowai-backend starting");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|err| panic!("failed to bind {addr}: {err}"));
    axum::serve(listener, app)
        .await
        .unwrap_or_else(|err| panic!("server error: {err}"));
}
