use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use todowai_backend::ai::{AiConfig, AiProvider};
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

    // Settings saved via the app persist to a local, git-ignored file inside the subfolder (see
    // Repository::save_settings_section) so they survive a restart without retyping — this is
    // the primary source once anything's been saved through Settings. Env vars remain a pure
    // first-run seed: they only apply to whichever section (remote/ai) the persisted file
    // doesn't already have an answer for, never overriding something the user already saved.
    let persisted_settings = repository.load_settings();

    let persisted_remote: Option<RemoteConfig> = persisted_settings
        .get("remote")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let remote_config = persisted_remote.or_else(|| {
        let remote_url = std::env::var("TODOWAI_REMOTE_URL").unwrap_or_default();
        (!remote_url.trim().is_empty()).then(|| RemoteConfig {
            url: remote_url,
            username: std::env::var("TODOWAI_REMOTE_USERNAME").unwrap_or_default(),
            token: std::env::var("TODOWAI_REMOTE_TOKEN").unwrap_or_default(),
        })
    });
    if let Some(remote_config) = remote_config {
        repository.set_remote(Some(remote_config));
    }

    let shared_repository: api::SharedRepository = Arc::new(Mutex::new(repository));

    // TODOWAI_AI_PROVIDER unset (or unrecognized), and nothing persisted yet either, means AI
    // features are simply disabled until configured via Settings.
    let persisted_ai: Option<AiConfig> = persisted_settings
        .get("ai")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let ai_config = persisted_ai.or_else(|| {
        std::env::var("TODOWAI_AI_PROVIDER")
            .ok()
            .and_then(|value| AiProvider::parse_env_value(&value))
            .map(|provider| AiConfig {
                provider,
                api_key: std::env::var("TODOWAI_AI_API_KEY").unwrap_or_default(),
                model: std::env::var("TODOWAI_AI_MODEL").ok().filter(|value| !value.trim().is_empty()),
                base_url: std::env::var("TODOWAI_AI_BASE_URL").ok().filter(|value| !value.trim().is_empty()),
                max_completion_tokens: std::env::var("TODOWAI_AI_MAX_COMPLETION_TOKENS").ok().and_then(|value| value.parse().ok()),
            })
    });
    let shared_ai_config: api::SharedAiConfig = Arc::new(Mutex::new(ai_config));

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
        ai_config: shared_ai_config,
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
