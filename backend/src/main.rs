use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use todowai_backend::api::{self, AppState};
use todowai_backend::repository::{RemoteConfig, Repository};
use todowai_backend::sync::{RepositoryBackend, SyncScheduler};

const DEFAULT_PUSH_DEBOUNCE_MS: u64 = 4_000;
const DEFAULT_BACKGROUND_PULL_INTERVAL_MS: u64 = 5 * 60 * 1_000;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // TODOWAI_REPO_PATH is expected to be a Docker volume mount in the self-hosted deployment.
    let repo_path = std::env::var("TODOWAI_REPO_PATH").unwrap_or_else(|_| "/vault".to_string());
    let ui_dir = std::env::var("TODOWAI_UI_DIR").unwrap_or_else(|_| "./static".to_string());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080);

    let mut repository = Repository::open(PathBuf::from(&repo_path).as_path())
        .unwrap_or_else(|err| panic!("failed to open git repository at {repo_path}: {err}"));
    // Set once at startup from config, not re-picked interactively per session — this backend
    // has one vault and one subfolder for its whole lifetime, unlike the superseded per-browser-
    // tab model.
    if let Ok(subfolder) = std::env::var("TODOWAI_SUBFOLDER") {
        repository.set_subfolder(&subfolder);
    }

    // Remote credentials are in-memory only too, consistent with the subfolder above — nothing
    // persists across restarts yet. An env-configured default is supported for convenience (set
    // it once in your deployment config), and PUT /api/sync/remote can still override it later
    // without a restart.
    let remote_url = std::env::var("TODOWAI_REMOTE_URL").unwrap_or_default();
    if !remote_url.trim().is_empty() {
        repository.set_remote(Some(RemoteConfig {
            url: remote_url,
            username: std::env::var("TODOWAI_REMOTE_USERNAME").unwrap_or_default(),
            token: std::env::var("TODOWAI_REMOTE_TOKEN").unwrap_or_default(),
        }));
    }

    let shared_repository: api::SharedRepository = Arc::new(Mutex::new(repository));

    let push_debounce_ms: u64 = std::env::var("TODOWAI_PUSH_DEBOUNCE_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PUSH_DEBOUNCE_MS);
    let background_pull_interval_ms: u64 = std::env::var("TODOWAI_BACKGROUND_PULL_INTERVAL_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_BACKGROUND_PULL_INTERVAL_MS);

    let backend = RepositoryBackend {
        repository: shared_repository.clone(),
        author_name: std::env::var("TODOWAI_SYNC_AUTHOR_NAME").unwrap_or_else(|_| "Todowai Sync".to_string()),
        author_email: std::env::var("TODOWAI_SYNC_AUTHOR_EMAIL")
            .unwrap_or_else(|_| "todowai-sync@example.invalid".to_string()),
    };
    let scheduler = SyncScheduler::new(
        backend,
        Duration::from_millis(push_debounce_ms),
        Duration::from_millis(background_pull_interval_ms),
    );
    // Always started, regardless of whether a remote is configured yet: pulling/pushing with no
    // remote is a cheap, immediate no-op (see Repository::pull/push), and a remote configured
    // later via PUT /api/sync/remote is picked up on the next interval tick without a restart.
    scheduler.start();

    let state = AppState {
        repository: shared_repository,
        scheduler,
    };

    // Hash-based client-side routing (e.g. `#/settings`) means the browser never requests a
    // deep path from the server for a client route, so a plain static file service is enough —
    // no SPA history-API fallback-to-index.html rewriting is needed.
    let app = api::router(state)
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
