use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum RepoError {
    NotFound(String),
    InvalidPath(String),
    NothingToCommit,
    Git(git2::Error),
    Io(std::io::Error),
}

impl std::fmt::Display for RepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RepoError::NotFound(path) => write!(f, "not found: {path}"),
            RepoError::InvalidPath(path) => write!(f, "invalid path: {path}"),
            RepoError::NothingToCommit => write!(f, "nothing to commit"),
            RepoError::Git(err) => write!(f, "git error: {err}"),
            RepoError::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

impl std::error::Error for RepoError {}

impl From<git2::Error> for RepoError {
    fn from(err: git2::Error) -> Self {
        RepoError::Git(err)
    }
}

impl From<std::io::Error> for RepoError {
    fn from(err: std::io::Error) -> Self {
        RepoError::Io(err)
    }
}

impl IntoResponse for RepoError {
    fn into_response(self) -> Response {
        let status = match &self {
            RepoError::NotFound(_) => StatusCode::NOT_FOUND,
            RepoError::InvalidPath(_) => StatusCode::BAD_REQUEST,
            RepoError::NothingToCommit => StatusCode::BAD_REQUEST,
            RepoError::Git(_) | RepoError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}
