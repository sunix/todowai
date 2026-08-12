use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::error::RepoError;
use crate::repository::{CommitResult, Repository, Snapshot};

pub type SharedRepository = Arc<Mutex<Repository>>;

pub fn router(repository: SharedRepository) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/repository", get(get_snapshot))
        .route("/api/repository/file", get(read_file).put(write_file))
        .route("/api/repository/commit", post(commit_all))
        .with_state(repository)
}

async fn health() -> &'static str {
    "ok"
}

async fn get_snapshot(
    State(repository): State<SharedRepository>,
) -> Result<Json<Snapshot>, RepoError> {
    let repository = repository.lock().await;
    Ok(Json(repository.snapshot()?))
}

#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    path: String,
}

async fn read_file(
    State(repository): State<SharedRepository>,
    Query(query): Query<FilePathQuery>,
) -> Result<String, RepoError> {
    let repository = repository.lock().await;
    repository.read_file(&query.path)
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
    let repository = repository.lock().await;
    repository.write_file(&body.path, &body.content)?;
    Ok(Json(repository.snapshot()?))
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
    Json(body): Json<CommitRequest>,
) -> Result<Json<CommitResult>, RepoError> {
    let repository = repository.lock().await;
    Ok(Json(repository.commit_all(
        &body.message,
        &body.author_name,
        &body.author_email,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
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

    #[tokio::test]
    async fn health_check_responds_ok() {
        let temp = tempfile::tempdir().unwrap();
        let repository: SharedRepository = Arc::new(Mutex::new(init_repo(temp.path())));
        let app = router(repository);

        let response = app
            .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn snapshot_reflects_seeded_commit() {
        let temp = tempfile::tempdir().unwrap();
        let repository: SharedRepository = Arc::new(Mutex::new(init_repo(temp.path())));
        let app = router(repository);

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
        let repository: SharedRepository = Arc::new(Mutex::new(init_repo(temp.path())));
        let app = router(repository);

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
        let repository: SharedRepository = Arc::new(Mutex::new(init_repo(temp.path())));
        let app = router(repository);

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
}
