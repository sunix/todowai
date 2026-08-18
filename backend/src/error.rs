use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum RepoError {
    NotFound(String),
    InvalidPath(String),
    /// The file exists but isn't valid UTF-8 text (e.g. an image or other binary file) — the
    /// read/write-file endpoints only ever serve text, so this is the caller's mistake (picked
    /// the wrong path), not a server fault. Distinguished from a generic Io error specifically
    /// so it doesn't surface as a 500 with a raw Rust error string.
    NotText(String),
    NothingToCommit,
    /// A resolve-conflict request that doesn't match the actual pending state (nothing to
    /// resolve, or it didn't cover every conflicted file) — a client mistake, not a git failure.
    ConflictResolutionFailed(String),
    /// No AI provider is configured yet — a client mistake (visit Settings first), not an
    /// upstream failure.
    AiNotConfigured,
    /// A misconfiguration only the caller can fix (e.g. no model set for a provider that
    /// requires one).
    AiMisconfigured(String),
    /// The configured AI provider was reachable but the request failed there, or its response
    /// couldn't be understood — an upstream failure, not a client mistake.
    AiRequestFailed(String),
    Git(git2::Error),
    Io(std::io::Error),
    /// The blocking task running the repository operation panicked (see api::with_repository).
    TaskFailed(String),
}

impl std::fmt::Display for RepoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RepoError::NotFound(path) => write!(f, "not found: {path}"),
            RepoError::InvalidPath(path) => write!(f, "invalid path: {path}"),
            RepoError::NotText(path) => write!(f, "cannot read \"{path}\" as text (binary or non-UTF-8 file)"),
            RepoError::NothingToCommit => write!(f, "nothing to commit"),
            RepoError::ConflictResolutionFailed(message) => write!(f, "conflict resolution failed: {message}"),
            RepoError::AiNotConfigured => write!(f, "no AI provider is configured"),
            RepoError::AiMisconfigured(message) => write!(f, "{message}"),
            RepoError::AiRequestFailed(message) => write!(f, "{message}"),
            RepoError::Git(err) => write!(f, "git error: {err}"),
            RepoError::Io(err) => write!(f, "io error: {err}"),
            RepoError::TaskFailed(message) => write!(f, "internal error: {message}"),
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

impl From<crate::ai::AiError> for RepoError {
    fn from(err: crate::ai::AiError) -> Self {
        match err {
            crate::ai::AiError::NotConfigured => RepoError::AiNotConfigured,
            crate::ai::AiError::Configuration(message) => RepoError::AiMisconfigured(message),
            crate::ai::AiError::Request(message) => RepoError::AiRequestFailed(message),
        }
    }
}

impl IntoResponse for RepoError {
    fn into_response(self) -> Response {
        let status = match &self {
            RepoError::NotFound(_) => StatusCode::NOT_FOUND,
            RepoError::InvalidPath(_) => StatusCode::BAD_REQUEST,
            RepoError::NotText(_) => StatusCode::BAD_REQUEST,
            RepoError::NothingToCommit => StatusCode::BAD_REQUEST,
            RepoError::ConflictResolutionFailed(_) => StatusCode::BAD_REQUEST,
            RepoError::AiNotConfigured => StatusCode::BAD_REQUEST,
            RepoError::AiMisconfigured(_) => StatusCode::BAD_REQUEST,
            RepoError::AiRequestFailed(_) => StatusCode::BAD_GATEWAY,
            RepoError::Git(_) | RepoError::Io(_) | RepoError::TaskFailed(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}
