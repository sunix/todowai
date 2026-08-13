use std::path::{Component, Path, PathBuf};

use git2::StatusOptions;
use serde::{Deserialize, Serialize};

use crate::error::RepoError;

const DEFAULT_SUBFOLDER: &str = "todowai";
// Never read, written, listed, staged, or committed — .git is git's own internals, and
// .obsidian can hold sensitive plugin data belonging to a coexisting Obsidian vault that
// Todowai must not disturb. Checked against a path's first component only (a top-level
// name), matching how these directories actually appear in a vault.
const PROTECTED_TOP_LEVEL_NAMES: [&str; 2] = [".git", ".obsidian"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub filepath: String,
    pub change_type: ChangeType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub oid: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub committed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub folder_name: String,
    pub subfolder: String,
    pub files: Vec<String>,
    pub history: Vec<HistoryEntry>,
    pub pending_changes: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub oid: String,
    pub files: Vec<String>,
    pub pending_changes: Vec<FileChange>,
}

const HISTORY_DEPTH: usize = 10;

/// Wraps a single git2::Repository opened against a real filesystem path (a Docker
/// volume mount, in the self-hosted deployment). Unlike the superseded browser-based
/// controller (File System Access API + isomorphic-git, see ADR-001), every operation
/// here is a direct, synchronous filesystem/libgit2 call with no per-call permission
/// round-trip — so, deliberately, this does NOT port over the old in-memory incremental
/// status-tracking optimization. That existed to work around the browser FS Access API
/// being slow one directory/file at a time; git2's `statuses()` walks the real working
/// directory natively and is already fast enough here. If a very large vault ever makes
/// it a bottleneck, incremental tracking (seed once, update scoped paths) is the proven
/// pattern to reach for — see the superseded #10/#12 implementations for the approach.
pub struct Repository {
    repo: git2::Repository,
    workdir: PathBuf,
    subfolder: String,
}

impl Repository {
    pub fn open(path: &Path) -> Result<Self, RepoError> {
        let repo = git2::Repository::open(path)?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| RepoError::InvalidPath(path.display().to_string()))?
            .to_path_buf();
        Ok(Self {
            repo,
            workdir,
            subfolder: DEFAULT_SUBFOLDER.to_string(),
        })
    }

    pub fn folder_name(&self) -> String {
        self.workdir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.workdir.display().to_string())
    }

    pub fn subfolder(&self) -> &str {
        &self.subfolder
    }

    /// Where Todowai's own files live. Outside this subfolder, existing files can still be
    /// read and edited (e.g. notes in an existing Obsidian vault) via write_file, but
    /// write_file refuses to create new ones there, and commit_all won't stage externally
    /// caused deletions there either — see is_inside_subfolder and is_manageable.
    pub fn set_subfolder(&mut self, name: &str) {
        let trimmed = name.trim().trim_matches('/');
        self.subfolder = if trimmed.is_empty() {
            DEFAULT_SUBFOLDER.to_string()
        } else {
            trimmed.to_string()
        };
    }

    /// Checked against a path's first component, matching PROTECTED_TOP_LEVEL_NAMES.
    fn is_protected(relpath: &str) -> bool {
        Path::new(relpath)
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            .is_some_and(|first| {
                PROTECTED_TOP_LEVEL_NAMES
                    .iter()
                    .any(|protected| first.eq_ignore_ascii_case(protected))
            })
    }

    /// A prefix check on the path string, not just the first component — the subfolder name
    /// is user-configured and may itself contain a `/` (e.g. `notes/todowai`), unlike the
    /// fixed, always-single-segment PROTECTED_TOP_LEVEL_NAMES.
    fn is_inside_subfolder(&self, relpath: &str) -> bool {
        relpath == self.subfolder || relpath.starts_with(&format!("{}/", self.subfolder))
    }

    /// Validates a caller-supplied relative path before it ever touches the filesystem.
    /// Rejects absolute paths and any `..` component outright, rather than relying on
    /// `canonicalize()` (which requires the target to already exist, so it can't guard a
    /// new file's write path). This matters much more here than it did in the old
    /// browser-only app: this is now a network-facing API, so an unvalidated path is a
    /// real path-traversal vector, not just a self-inflicted browser-permission mistake.
    /// Also rejects `.git`/`.obsidian` paths — see is_protected.
    fn resolve_relative_path(&self, relpath: &str) -> Result<PathBuf, RepoError> {
        if relpath.is_empty() {
            return Err(RepoError::InvalidPath(relpath.to_string()));
        }
        for component in Path::new(relpath).components() {
            match component {
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err(RepoError::InvalidPath(relpath.to_string()));
                }
                _ => {}
            }
        }
        if Self::is_protected(relpath) {
            return Err(RepoError::InvalidPath(relpath.to_string()));
        }
        Ok(self.workdir.join(relpath))
    }

    fn relative_path(&self, absolute: &Path) -> String {
        absolute
            .strip_prefix(&self.workdir)
            .unwrap_or(absolute)
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// Lists every regular file in the working directory, excluding `.git`/`.obsidian`.
    pub fn list_files(&self) -> Result<Vec<String>, RepoError> {
        let mut files: Vec<String> = walkdir::WalkDir::new(&self.workdir)
            .into_iter()
            .filter_entry(|entry| {
                !entry.file_name().to_str().is_some_and(|name| {
                    PROTECTED_TOP_LEVEL_NAMES
                        .iter()
                        .any(|protected| name.eq_ignore_ascii_case(protected))
                })
            })
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| self.relative_path(entry.path()))
            .collect();
        files.sort();
        Ok(files)
    }

    fn statuses(&self) -> Result<Vec<FileChange>, RepoError> {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = self.repo.statuses(Some(&mut opts))?;

        let mut changes: Vec<FileChange> = statuses
            .iter()
            .filter_map(|entry| {
                let path = entry.path()?.to_string();
                if Self::is_protected(&path) {
                    return None;
                }
                let status = entry.status();
                let change_type = if status.intersects(
                    git2::Status::INDEX_DELETED | git2::Status::WT_DELETED,
                ) {
                    ChangeType::Deleted
                } else if status.intersects(git2::Status::INDEX_NEW | git2::Status::WT_NEW) {
                    ChangeType::Added
                } else {
                    ChangeType::Modified
                };
                Some(FileChange {
                    filepath: path,
                    change_type,
                })
            })
            .collect();
        changes.sort_by(|a, b| a.filepath.cmp(&b.filepath));
        Ok(changes)
    }

    pub fn recent_history(&self, depth: usize) -> Result<Vec<HistoryEntry>, RepoError> {
        if self.repo.head().is_err() {
            // Fresh repo with no commits yet — an empty history is a valid, common state,
            // not an error.
            return Ok(Vec::new());
        }

        let mut revwalk = self.repo.revwalk()?;
        revwalk.push_head()?;
        revwalk.set_sorting(git2::Sort::TIME)?;

        revwalk
            .take(depth)
            .map(|oid| {
                let oid = oid?;
                let commit = self.repo.find_commit(oid)?;
                let author = commit.author();
                let time = commit.time();
                let committed_at = chrono::DateTime::<chrono::Utc>::from_timestamp(time.seconds(), 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default();
                Ok(HistoryEntry {
                    oid: commit.id().to_string(),
                    message: commit.message().unwrap_or("").trim().to_string(),
                    author_name: author.name().unwrap_or("").to_string(),
                    author_email: author.email().unwrap_or("").to_string(),
                    committed_at,
                })
            })
            .collect::<Result<Vec<_>, git2::Error>>()
            .map_err(RepoError::from)
    }

    pub fn snapshot(&self) -> Result<Snapshot, RepoError> {
        Ok(Snapshot {
            folder_name: self.folder_name(),
            subfolder: self.subfolder.clone(),
            files: self.list_files()?,
            history: self.recent_history(HISTORY_DEPTH)?,
            pending_changes: self.statuses()?,
        })
    }

    pub fn read_file(&self, relpath: &str) -> Result<String, RepoError> {
        let path = self.resolve_relative_path(relpath)?;
        if !path.is_file() {
            return Err(RepoError::NotFound(relpath.to_string()));
        }
        Ok(std::fs::read_to_string(path)?)
    }

    /// Outside the configured subfolder, editing an existing file is fine (that's how notes
    /// in a coexisting Obsidian vault stay editable), but creating a brand new one is not —
    /// new content Todowai creates always goes inside its own subfolder.
    pub fn write_file(&self, relpath: &str, content: &str) -> Result<(), RepoError> {
        let path = self.resolve_relative_path(relpath)?;
        if !self.is_inside_subfolder(relpath) && !path.is_file() {
            return Err(RepoError::InvalidPath(format!(
                "cannot create \"{relpath}\" outside the \"{}\" subfolder",
                self.subfolder
            )));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
        Ok(())
    }

    /// Inside the subfolder, every pending change is manageable (full CRUD). Outside it, only
    /// modifications to already-tracked files are — a new file appearing outside the subfolder
    /// (created by some other tool directly on disk, since write_file itself already refuses
    /// to create one there) isn't something Todowai put there, and a deletion outside the
    /// subfolder isn't staged/committed either, per the vault-coexistence rules: Todowai only
    /// creates and deletes inside its own subfolder.
    fn is_manageable(&self, change: &FileChange) -> bool {
        self.is_inside_subfolder(&change.filepath) || change.change_type == ChangeType::Modified
    }

    /// Stages every manageable pending change (adds, modifications, and deletions inside the
    /// subfolder; modifications only outside it — see is_manageable) and commits it, staging
    /// each path individually rather than via a blanket `git add -A`-style pathspec so the
    /// exclusion is exact.
    pub fn commit_all(
        &self,
        message: &str,
        author_name: &str,
        author_email: &str,
    ) -> Result<CommitResult, RepoError> {
        let pending = self.statuses()?;
        let manageable: Vec<&FileChange> = pending.iter().filter(|c| self.is_manageable(c)).collect();
        if manageable.is_empty() {
            return Err(RepoError::NothingToCommit);
        }

        let mut index = self.repo.index()?;
        for change in &manageable {
            match change.change_type {
                ChangeType::Deleted => index.remove_path(Path::new(&change.filepath))?,
                ChangeType::Added | ChangeType::Modified => {
                    index.add_path(Path::new(&change.filepath))?
                }
            }
        }
        index.write()?;

        let tree_oid = index.write_tree()?;
        let tree = self.repo.find_tree(tree_oid)?;
        let signature = git2::Signature::now(author_name, author_email)?;

        let parent_commit = self.repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

        let oid = self
            .repo
            .commit(Some("HEAD"), &signature, &signature, message, &tree, &parents)?;

        Ok(CommitResult {
            oid: oid.to_string(),
            files: self.list_files()?,
            pending_changes: self.statuses()?,
        })
    }
}
