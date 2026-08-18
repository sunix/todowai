use std::sync::{Arc, Mutex};

use axum::extract::{FromRef, Query, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use crate::ai::{AiClassification, AiConfig, AiConfigView, BacklogNote, NextActionSuggestion};
use crate::calendar::{CalendarEvent, CalendarFeedConfig};
use crate::error::RepoError;
use crate::repository::{
    CommitResult, ConfiguredRemote, ConflictInfo, ConflictResolution, RemoteConfig, Repository, Snapshot, SyncResult,
};
use crate::sync::SyncScheduler;

/// A plain std::sync::Mutex, not tokio's — every Repository operation (libgit2, std::fs) is
/// blocking, so handlers run them via with_repository/spawn_blocking rather than holding an
/// async mutex guard across an .await while doing blocking work on a tokio worker thread. This
/// matters far more since #62 added pull/push: a multi-second network call must never stall
/// every other request through a shared lock the way it would with a plain `.lock().await` here.
pub type SharedRepository = Arc<Mutex<Repository>>;

/// AI credentials/provider choice, kept in memory only — same rationale as the repository's
/// RemoteConfig (see repository.rs). A plain std::sync::Mutex is fine here (unlike the
/// repository's, which guards blocking libgit2 calls): reads/writes are just a cheap struct
/// clone, never held across an .await.
pub type SharedAiConfig = Arc<Mutex<Option<AiConfig>>>;

#[derive(Clone)]
pub struct AppState {
    pub repository: SharedRepository,
    pub scheduler: SyncScheduler,
    pub ai_config: SharedAiConfig,
}

impl FromRef<AppState> for SharedRepository {
    fn from_ref(state: &AppState) -> Self {
        state.repository.clone()
    }
}

impl FromRef<AppState> for SyncScheduler {
    fn from_ref(state: &AppState) -> Self {
        state.scheduler.clone()
    }
}

impl FromRef<AppState> for SharedAiConfig {
    fn from_ref(state: &AppState) -> Self {
        state.ai_config.clone()
    }
}

/// Runs a repository operation on the blocking-task pool, never on a tokio worker thread.
async fn with_repository<T, F>(repository: SharedRepository, f: F) -> Result<T, RepoError>
where
    T: Send + 'static,
    F: FnOnce(&mut Repository) -> Result<T, RepoError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut repository = repository.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut repository)
    })
    .await
    .unwrap_or_else(|join_error| Err(RepoError::TaskFailed(join_error.to_string())))
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/repository", get(get_snapshot))
        .route("/api/repository/file", get(read_file).put(write_file))
        .route("/api/repository/commit", post(commit_all))
        .route("/api/sync/remote", put(set_remote))
        .route("/api/sync/remotes", get(list_configured_remotes))
        .route("/api/sync/status", get(sync_status))
        .route("/api/sync/pull", post(sync_pull))
        .route("/api/sync/push", post(sync_push))
        .route("/api/sync/conflict", get(get_conflict))
        .route("/api/sync/conflict/resolve", post(resolve_conflict))
        .route("/api/ai/config", get(get_ai_config).put(set_ai_config))
        .route("/api/ai/classify", post(classify_capture))
        .route("/api/ai/models", get(list_ai_models))
        .route("/api/ai/suggest-next-action", post(suggest_next_action))
        .route("/api/calendar/upcoming", get(upcoming_calendar_events))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn get_snapshot(State(repository): State<SharedRepository>) -> Result<Json<Snapshot>, RepoError> {
    let snapshot = with_repository(repository, |repo| repo.snapshot()).await?;
    Ok(Json(snapshot))
}

#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    path: String,
}

async fn read_file(
    State(repository): State<SharedRepository>,
    Query(query): Query<FilePathQuery>,
) -> Result<String, RepoError> {
    with_repository(repository, move |repo| repo.read_file(&query.path)).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    path: String,
    content: String,
}

async fn write_file(
    State(repository): State<SharedRepository>,
    Json(body): Json<WriteFileRequest>,
) -> Result<Json<Snapshot>, RepoError> {
    let snapshot = with_repository(repository, move |repo| {
        repo.write_file(&body.path, &body.content)?;
        repo.snapshot()
    })
    .await?;
    Ok(Json(snapshot))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    message: String,
    author_name: String,
    author_email: String,
}

async fn commit_all(
    State(repository): State<SharedRepository>,
    State(scheduler): State<SyncScheduler>,
    Json(body): Json<CommitRequest>,
) -> Result<Json<CommitResult>, RepoError> {
    let result = with_repository(repository, move |repo| {
        repo.commit_all(&body.message, &body.author_name, &body.author_email)
    })
    .await?;

    // A commit is the only thing that can actually be pushed, so scheduling happens here rather
    // than on every save. Debounced (not immediate): manual edits shouldn't push on every single
    // commit made in quick succession — see SyncScheduler::request_push.
    scheduler.request_push(false).await;

    Ok(Json(result))
}

/// Built by hand rather than deriving Serialize on RemoteConfig — see its doc comment for why
/// that's deliberate (a PAT must never be structurally serializable into an API response).
fn remote_settings_json(remote: &RemoteConfig) -> serde_json::Value {
    serde_json::json!({ "url": remote.url, "username": remote.username, "token": remote.token })
}

async fn set_remote(
    State(repository): State<SharedRepository>,
    Json(body): Json<Option<RemoteConfig>>,
) -> Result<(), RepoError> {
    let settings_value = body.as_ref().map(remote_settings_json);
    with_repository(repository, move |repo| {
        repo.set_remote(body);
        // Best-effort: a filesystem hiccup persisting for next time shouldn't fail using the
        // remote for this session, which already succeeded above.
        if let Err(error) = repo.save_settings_section("remote", settings_value) {
            tracing::warn!(%error, "failed to persist remote settings locally");
        }
        Ok(())
    })
    .await
}

async fn list_configured_remotes(
    State(repository): State<SharedRepository>,
) -> Result<Json<Vec<ConfiguredRemote>>, RepoError> {
    let remotes = with_repository(repository, |repo| repo.list_configured_remotes()).await?;
    Ok(Json(remotes))
}

async fn sync_status(State(scheduler): State<SyncScheduler>) -> Json<SyncResult> {
    Json(scheduler.status())
}

async fn sync_pull(State(scheduler): State<SyncScheduler>) -> Json<SyncResult> {
    scheduler.pull_now().await;
    Json(scheduler.status())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    #[serde(default = "default_true")]
    immediate: bool,
}

fn default_true() -> bool {
    true
}

async fn sync_push(
    State(scheduler): State<SyncScheduler>,
    body: Option<Json<PushRequest>>,
) -> Json<SyncResult> {
    let immediate = body.map(|Json(request)| request.immediate).unwrap_or(true);
    scheduler.request_push(immediate).await;
    Json(scheduler.status())
}

async fn get_conflict(State(repository): State<SharedRepository>) -> Result<Json<Option<ConflictInfo>>, RepoError> {
    let conflict = with_repository(repository, |repo| Ok(repo.pending_conflict())).await?;
    Ok(Json(conflict))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveConflictRequest {
    resolutions: Vec<ConflictResolution>,
}

async fn resolve_conflict(
    State(repository): State<SharedRepository>,
    State(scheduler): State<SyncScheduler>,
    Json(body): Json<ResolveConflictRequest>,
) -> Result<Json<SyncResult>, RepoError> {
    let (author_name, author_email) = scheduler.author();
    let (author_name, author_email) = (author_name.to_string(), author_email.to_string());

    with_repository(repository, move |repo| {
        repo.resolve_conflict(&body.resolutions, &author_name, &author_email)
    })
    .await?;

    // The resolution is only a local merge commit until it reaches the remote — push it right
    // away rather than waiting for the debounce, matching how a manual "Sync now" behaves.
    scheduler.request_push(true).await;
    Ok(Json(scheduler.status()))
}

async fn get_ai_config(State(ai_config): State<SharedAiConfig>) -> Json<AiConfigView> {
    let config = ai_config.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Json(AiConfigView::from_config(config.as_ref()))
}

/// Built by hand rather than deriving Serialize on AiConfig — see its doc comment for why
/// that's deliberate (an API key must never be structurally serializable into an API response).
fn ai_settings_json(config: &AiConfig) -> serde_json::Value {
    serde_json::json!({
        "provider": config.provider,
        "apiKey": config.api_key,
        "model": config.model,
        "baseUrl": config.base_url,
    })
}

/// `null` clears the configured provider entirely — same convention as PUT /api/sync/remote.
async fn set_ai_config(
    State(repository): State<SharedRepository>,
    State(ai_config): State<SharedAiConfig>,
    Json(body): Json<Option<AiConfig>>,
) -> Json<AiConfigView> {
    let settings_value = body.as_ref().map(ai_settings_json);
    // Best-effort: a filesystem hiccup persisting for next time shouldn't block using the
    // provider right now — the in-memory update below always takes effect regardless.
    if let Err(error) = with_repository(repository, move |repo| repo.save_settings_section("ai", settings_value)).await {
        tracing::warn!(%error, "failed to persist AI settings locally");
    }

    let mut config = ai_config.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *config = body;
    Json(AiConfigView::from_config(config.as_ref()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifyRequest {
    text: String,
}

async fn classify_capture(
    State(ai_config): State<SharedAiConfig>,
    Json(body): Json<ClassifyRequest>,
) -> Result<Json<AiClassification>, RepoError> {
    let config = {
        let guard = ai_config.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clone()
    };
    let config = config.ok_or(RepoError::AiNotConfigured)?;
    let classification = crate::ai::classify(&body.text, &config).await?;
    Ok(Json(classification))
}

/// Backs the Model field's suggestion dropdown in Settings — queries the *saved* config's
/// provider, not whatever is currently typed but unsaved in the form (same convention as
/// /api/sync/remotes reading the repository's actual git config, not a form draft).
async fn list_ai_models(State(ai_config): State<SharedAiConfig>) -> Result<Json<Vec<String>>, RepoError> {
    let config = {
        let guard = ai_config.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clone()
    };
    let config = config.ok_or(RepoError::AiNotConfigured)?;
    let models = crate::ai::list_models(&config).await?;
    Ok(Json(models))
}

/// Read here, not proposed as an addition — Next Action already reads/writes it directly via
/// the generic file endpoints (see app/src/main.ts's STATUS_FILE_NAME), this just needs the
/// same well-known name to fold it into the suggestion prompt.
const STATUS_FILE_NAME: &str = "status.md";

/// Caps how many backlog notes get read per suggestion request — a personal vault's backlog is
/// expected to stay well under this, and it bounds both the I/O here and the prompt built from
/// it (see ai::MAX_NOTE_CHARS_IN_PROMPT for the per-note cap).
const MAX_BACKLOG_NOTES_FOR_SUGGESTION: usize = 30;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestNextActionRequest {
    /// Suggestions already shown and rejected this Next Action session — passed back so the
    /// prompt can explicitly steer away from repeating them (see ai::build_suggestion_prompt).
    #[serde(default)]
    excluded_suggestions: Vec<String>,
}

async fn suggest_next_action(
    State(repository): State<SharedRepository>,
    State(ai_config): State<SharedAiConfig>,
    Json(body): Json<SuggestNextActionRequest>,
) -> Result<Json<NextActionSuggestion>, RepoError> {
    let config = {
        let guard = ai_config.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clone()
    };
    let config = config.ok_or(RepoError::AiNotConfigured)?;

    let (status, backlog_notes) = with_repository(repository, move |repo| {
        let status_path = format!("{}/{STATUS_FILE_NAME}", repo.subfolder());
        // No status set yet is not an error here — the suggestion just proceeds without one,
        // same quiet-fallback treatment the frontend gives a missing status file.
        let status = repo.read_file(&status_path).ok();

        let backlog_prefix = format!("{}/backlog/", repo.subfolder());
        let backlog_paths: Vec<String> = repo
            .list_files()?
            .into_iter()
            .filter(|path| path.starts_with(&backlog_prefix) && path.ends_with(".md"))
            .take(MAX_BACKLOG_NOTES_FOR_SUGGESTION)
            .collect();
        let backlog_notes: Vec<BacklogNote> = backlog_paths
            .into_iter()
            .filter_map(|path| {
                let content = repo.read_file(&path).ok()?;
                Some(BacklogNote { path, content })
            })
            .collect();

        Ok((status, backlog_notes))
    })
    .await?;

    let suggestion =
        crate::ai::suggest_next_action(status.as_deref(), &backlog_notes, &body.excluded_suggestions, &config).await?;
    Ok(Json(suggestion))
}

/// Same well-known name as app/src/main.ts's CALENDAR_FEEDS_FILE_NAME — see #22. No configured
/// feeds (file missing, or present but empty) is a normal, common state, not an error: the
/// frontend already treats an absent file as "no feeds yet," so this mirrors that rather than
/// requiring AiNotConfigured-style client-error handling for an entirely optional feature.
const CALENDAR_FEEDS_FILE_NAME: &str = "calendars.json";

async fn upcoming_calendar_events(State(repository): State<SharedRepository>) -> Result<Json<Vec<CalendarEvent>>, RepoError> {
    let feeds: Vec<CalendarFeedConfig> = with_repository(repository, |repo| {
        let path = format!("{}/{CALENDAR_FEEDS_FILE_NAME}", repo.subfolder());
        let content = repo.read_file(&path).unwrap_or_else(|_| "[]".to_string());
        Ok(serde_json::from_str(&content).unwrap_or_default())
    })
    .await?;

    let events = crate::calendar::fetch_upcoming_events(&feeds).await;
    Ok(Json(events))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::time::Duration;
    use tower::ServiceExt;

    fn init_repo(dir: &std::path::Path) -> Repository {
        {
            let repo = git2::Repository::init(dir).unwrap();
            std::fs::write(dir.join("notes.md"), "# Notes").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("notes.md")).unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            let signature = git2::Signature::now("Seed", "seed@example.invalid").unwrap();
            repo.commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
                .unwrap();
        }
        Repository::open(dir).unwrap()
    }

    fn test_state(repository: Repository) -> AppState {
        let repository: SharedRepository = Arc::new(Mutex::new(repository));
        let backend = crate::sync::RepositoryBackend {
            repository: repository.clone(),
            author_name: "Todowai Sync".to_string(),
            author_email: "todowai-sync@example.invalid".to_string(),
        };
        let scheduler = SyncScheduler::new(backend, Duration::from_millis(50), Duration::from_secs(3600));
        AppState {
            repository,
            scheduler,
            ai_config: Arc::new(Mutex::new(None)),
        }
    }

    #[tokio::test]
    async fn health_check_responds_ok() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn snapshot_reflects_seeded_commit() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/repository")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let snapshot: Snapshot = serde_json::from_slice(&body).unwrap();
        assert_eq!(snapshot.files, vec!["notes.md".to_string()]);
        assert_eq!(snapshot.history.len(), 1);
        assert!(snapshot.pending_changes.is_empty());
    }

    #[tokio::test]
    async fn write_then_commit_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let write_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/repository/file")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({
                            "path": "notes.md",
                            "content": "# Notes\n\nUpdated"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(write_response.status(), StatusCode::OK);

        let commit_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/repository/commit")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({
                            "message": "docs: update notes",
                            "authorName": "Todowai User",
                            "authorEmail": "todowai@example.invalid"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(commit_response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(commit_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let result: CommitResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(result.oid.len(), 40);
        assert!(result.pending_changes.is_empty());
    }

    #[tokio::test]
    async fn path_traversal_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/repository/file?path=../outside.md")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn sync_status_reports_no_remote_by_default() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(Request::builder().uri("/api/sync/status").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let result: SyncResult = serde_json::from_slice(&body).unwrap();
        assert_eq!(result.status, crate::repository::SyncStatus::Error);
    }

    #[tokio::test]
    async fn ai_config_defaults_to_unconfigured() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(Request::builder().uri("/api/ai/config").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let view: crate::ai::AiConfigView = serde_json::from_slice(&body).unwrap();
        assert!(!view.configured);
        assert!(view.provider.is_none());
    }

    #[tokio::test]
    async fn setting_ai_config_never_echoes_the_api_key_back() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/ai/config")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({
                            "provider": "anthropic",
                            "apiKey": "sk-super-secret",
                            "model": "claude-opus-5",
                            "baseUrl": null
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body_text = String::from_utf8(body.to_vec()).unwrap();
        assert!(!body_text.contains("sk-super-secret"), "response leaked the API key: {body_text}");

        let view: crate::ai::AiConfigView = serde_json::from_str(&body_text).unwrap();
        assert!(view.configured);
        assert_eq!(view.model.as_deref(), Some("claude-opus-5"));
    }

    #[tokio::test]
    async fn setting_ai_config_persists_to_the_local_settings_file() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(init_repo(temp.path()));
        let repository = state.repository.clone();
        let app = router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/ai/config")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({
                            "provider": "anthropic",
                            "apiKey": "sk-super-secret",
                            "model": "claude-opus-5",
                            "baseUrl": null
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let persisted = repository.lock().unwrap().load_settings();
        assert_eq!(persisted["ai"]["provider"], "anthropic");
        assert_eq!(persisted["ai"]["apiKey"], "sk-super-secret");
    }

    #[tokio::test]
    async fn setting_remote_persists_to_the_local_settings_file() {
        let temp = tempfile::tempdir().unwrap();
        let state = test_state(init_repo(temp.path()));
        let repository = state.repository.clone();
        let app = router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/sync/remote")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({
                            "url": "https://example.invalid/repo.git",
                            "username": "git",
                            "token": "ghp_super_secret"
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let persisted = repository.lock().unwrap().load_settings();
        assert_eq!(persisted["remote"]["url"], "https://example.invalid/repo.git");
        assert_eq!(persisted["remote"]["token"], "ghp_super_secret");
    }

    #[tokio::test]
    async fn classify_without_a_configured_provider_is_a_client_error() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai/classify")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&serde_json::json!({ "text": "buy milk" })).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn suggest_next_action_without_a_configured_provider_is_a_client_error() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/ai/suggest-next-action")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&serde_json::json!({})).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn upcoming_calendar_events_with_no_feeds_configured_is_an_empty_list_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let app = router(test_state(init_repo(temp.path())));

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/calendar/upcoming")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let events: Vec<crate::calendar::CalendarEvent> = serde_json::from_slice(&body).unwrap();
        assert!(events.is_empty());
    }
}
