use std::sync::{Arc, Mutex};

use axum::extract::{FromRef, Query, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use crate::error::RepoError;
use crate::repository::{CommitResult, RemoteConfig, Repository, Snapshot, SyncResult};
use crate::sync::SyncScheduler;

/// A plain std::sync::Mutex, not tokio's — every Repository operation (libgit2, std::fs) is
/// blocking, so handlers run them via with_repository/spawn_blocking rather than holding an
/// async mutex guard across an .await while doing blocking work on a tokio worker thread. This
/// matters far more since #62 added pull/push: a multi-second network call must never stall
/// every other request through a shared lock the way it would with a plain `.lock().await` here.
pub type SharedRepository = Arc<Mutex<Repository>>;

#[derive(Clone)]
pub struct AppState {
    pub repository: SharedRepository,
    pub scheduler: SyncScheduler,
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
        .route("/api/sync/status", get(sync_status))
        .route("/api/sync/pull", post(sync_pull))
        .route("/api/sync/push", post(sync_push))
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

async fn set_remote(
    State(repository): State<SharedRepository>,
    Json(body): Json<Option<RemoteConfig>>,
) -> Result<(), RepoError> {
    with_repository(repository, move |repo| {
        repo.set_remote(body);
        Ok(())
    })
    .await
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
        AppState { repository, scheduler }
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
}
