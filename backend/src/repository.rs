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

/// Kept in memory only, consistent with other settings not persisting yet (see #60's
/// subfolder). Never Serialize'd back out — a snapshot must never echo a PAT.
#[derive(Debug, Clone, Deserialize)]
pub struct RemoteConfig {
    pub url: String,
    pub username: String,
    pub token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    Synced,
    Offline,
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub status: SyncStatus,
    pub message: String,
}

/// A remote already configured in `.git/config` (the same data `git remote -v` shows) — not
/// necessarily the one currently set via set_remote/RemoteConfig. Surfaced so the UI can offer
/// existing remotes (e.g. `origin`) as suggestions instead of requiring the URL to be retyped
/// from scratch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredRemote {
    pub name: String,
    pub url: String,
}

/// The files a real 3-way merge (see PullOutcome::Conflict) couldn't reconcile on its own —
/// surfaced so the UI can list them and let the user resolve each one via `resolve_conflict`,
/// rather than just repeating the same generic "could not merge" message every sync attempt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub files: Vec<String>,
}

/// Which side of a conflicted file to keep. Deliberately just two choices, not a hand-edited
/// merged result — a full diff/merge editor is out of scope for v1 (#13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Mine,
    Theirs,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub path: String,
    pub keep: ConflictSide,
}

/// What `resolve_conflict` needs to redo the exact same merge later: the fetched commit's
/// objects stay in the local object database once fetched (nothing prunes them mid-session), so
/// re-running `Repository::merge` against the same oid reproduces the identical conflicted index
/// deterministically — no need to stash trees/blobs separately just to support resolving later.
#[derive(Debug, Clone)]
struct PendingMerge {
    fetch_commit_oid: git2::Oid,
    files: Vec<String>,
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
    remote: Option<RemoteConfig>,
    pending_conflict: Option<PendingMerge>,
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
            remote: None,
            pending_conflict: None,
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

    pub fn has_remote(&self) -> bool {
        self.remote.is_some()
    }

    /// A real conflict from the most recent pull/push attempt that still needs a per-file
    /// keep-mine/keep-theirs decision via `resolve_conflict`. `None` once resolved, or once a
    /// later sync attempt supersedes it (e.g. a fresh, cleanly-merging pull).
    pub fn pending_conflict(&self) -> Option<ConflictInfo> {
        self.pending_conflict
            .as_ref()
            .map(|pending| ConflictInfo { files: pending.files.clone() })
    }

    /// Reads whatever remotes are already configured in this repo's `.git/config`. Never
    /// throws: an unreadable/unusual remote entry is just skipped, not a broken repository.
    pub fn list_configured_remotes(&self) -> Result<Vec<ConfiguredRemote>, RepoError> {
        let names = self.repo.remotes()?;
        let mut remotes: Vec<ConfiguredRemote> = names
            .iter()
            .flatten()
            .filter_map(|name| {
                let remote = self.repo.find_remote(name).ok()?;
                let url = remote.url()?;
                Some(ConfiguredRemote {
                    name: name.to_string(),
                    url: url.to_string(),
                })
            })
            .collect();
        remotes.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(remotes)
    }

    /// `None` (or an empty/whitespace-only URL) clears the configured remote entirely.
    pub fn set_remote(&mut self, remote: Option<RemoteConfig>) {
        self.remote = remote.and_then(|r| {
            let url = r.url.trim().to_string();
            if url.is_empty() {
                None
            } else {
                Some(RemoteConfig { url, ..r })
            }
        });
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
        std::fs::read_to_string(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                RepoError::NotText(relpath.to_string())
            } else {
                RepoError::Io(error)
            }
        })
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

    fn current_branch_name(&self) -> Result<String, git2::Error> {
        Ok(self
            .repo
            .head()
            .ok()
            .and_then(|head| head.shorthand().map(str::to_string))
            .unwrap_or_else(|| "main".to_string()))
    }

    fn remote_callbacks(remote: &RemoteConfig) -> git2::RemoteCallbacks<'_> {
        let username = remote.username.clone();
        let token = remote.token.clone();
        let mut callbacks = git2::RemoteCallbacks::new();
        callbacks.credentials(move |_url, _username_from_url, _allowed_types| {
            git2::Cred::userpass_plaintext(&username, &token)
        });
        callbacks
    }

    /// Never blocks the caller on network failure — every outcome (including "no remote
    /// configured") is a normal SyncResult, not a propagated error, matching the offline-first
    /// NFR: a pull failure must never stop the app from being usable.
    pub fn pull(&mut self, author_name: &str, author_email: &str) -> SyncResult {
        let Some(remote) = self.remote.clone() else {
            return SyncResult {
                status: SyncStatus::Error,
                message: "No remote configured.".to_string(),
            };
        };

        match self.pull_inner(&remote, author_name, author_email) {
            Ok(PullOutcome::UpToDate) => SyncResult {
                status: SyncStatus::Synced,
                message: "Already up to date.".to_string(),
            },
            Ok(PullOutcome::FastForwarded) => SyncResult {
                status: SyncStatus::Synced,
                message: "Synced — fast-forwarded to the latest remote changes.".to_string(),
            },
            Ok(PullOutcome::Merged(oid)) => SyncResult {
                status: SyncStatus::Synced,
                message: format!("Synced — merged remote changes ({}).", &oid[..7.min(oid.len())]),
            },
            Ok(PullOutcome::Conflict) => SyncResult {
                status: SyncStatus::Conflict,
                message: self.conflict_message(),
            },
            Err(error) => classify_sync_error(&error),
        }
    }

    fn pull_inner(
        &mut self,
        remote: &RemoteConfig,
        author_name: &str,
        author_email: &str,
    ) -> Result<PullOutcome, git2::Error> {
        let branch_name = self.current_branch_name()?;

        let mut git_remote = self.repo.remote_anonymous(&remote.url)?;
        let mut fetch_options = git2::FetchOptions::new();
        fetch_options.remote_callbacks(Self::remote_callbacks(remote));
        git_remote.fetch(&[branch_name.as_str()], Some(&mut fetch_options), None)?;

        let fetch_head = self.repo.find_reference("FETCH_HEAD")?;
        let fetch_commit = self.repo.reference_to_annotated_commit(&fetch_head)?;
        let (analysis, _preference) = self.repo.merge_analysis(&[&fetch_commit])?;

        if analysis.is_up_to_date() {
            self.pending_conflict = None;
            return Ok(PullOutcome::UpToDate);
        }

        if analysis.is_fast_forward() {
            let refname = format!("refs/heads/{branch_name}");
            match self.repo.find_reference(&refname) {
                Ok(mut reference) => {
                    reference.set_target(fetch_commit.id(), "todowai: fast-forward pull")?;
                }
                Err(_) => {
                    // Unborn branch (a fresh local repo with no commits yet).
                    self.repo.reference(&refname, fetch_commit.id(), true, "todowai: fast-forward pull")?;
                }
            }
            self.repo.set_head(&refname)?;
            self.repo
                .checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
            self.pending_conflict = None;
            return Ok(PullOutcome::FastForwarded);
        }

        self.repo.merge(&[&fetch_commit], None, None)?;
        let mut index = self.repo.index()?;

        if index.has_conflicts() {
            // Never leave the working tree full of `<<<<<<<` markers with no way to resolve
            // them — abort cleanly back to the pre-merge state instead; local work stays exactly
            // as it was, just unsynced. The conflicted paths are captured first so resolve_
            // conflict has something to act on later (see PendingMerge).
            let files = Self::conflicted_paths(&index)?;
            self.repo.cleanup_state()?;
            self.repo
                .checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
            self.pending_conflict = Some(PendingMerge { fetch_commit_oid: fetch_commit.id(), files });
            return Ok(PullOutcome::Conflict);
        }

        let tree_oid = index.write_tree()?;
        let tree = self.repo.find_tree(tree_oid)?;
        let signature = git2::Signature::now(author_name, author_email)?;
        let head_commit = self.repo.head()?.peel_to_commit()?;
        let fetch_commit_obj = self.repo.find_commit(fetch_commit.id())?;
        let merge_oid = self.repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Merge remote changes",
            &tree,
            &[&head_commit, &fetch_commit_obj],
        )?;
        self.repo.cleanup_state()?;
        self.pending_conflict = None;
        Ok(PullOutcome::Merged(merge_oid.to_string()))
    }

    /// Extracts the conflicted paths from a just-merged index with unresolved entries,
    /// preferring whichever side (ours/theirs/ancestor) actually has an entry — a delete/modify
    /// conflict can leave one side absent.
    fn conflicted_paths(index: &git2::Index) -> Result<Vec<String>, git2::Error> {
        let mut paths: Vec<String> = index
            .conflicts()?
            .filter_map(|conflict| conflict.ok())
            .filter_map(|conflict| {
                let entry = conflict.our.or(conflict.their).or(conflict.ancestor)?;
                String::from_utf8(entry.path).ok()
            })
            .collect();
        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    fn conflict_message(&self) -> String {
        match &self.pending_conflict {
            Some(pending) if !pending.files.is_empty() => format!(
                "Local and remote history could not be merged automatically — conflicting file{}: {}. Resolve in Settings to continue syncing.",
                if pending.files.len() == 1 { "" } else { "s" },
                pending.files.join(", ")
            ),
            _ => "Local and remote history could not be merged automatically — resolve manually for now.".to_string(),
        }
    }

    /// On a push rejected as non-fast-forward, tries the same 3-way merge `pull` uses instead of
    /// reporting a conflict outright — most rejected pushes are actually non-overlapping (a
    /// different file, or a non-overlapping hunk) and should reconcile with no user action, per
    /// #13's first acceptance criterion. Only a genuine overlapping edit still surfaces as a
    /// conflict, exactly like a conflicting pull would.
    pub fn push(&mut self, author_name: &str, author_email: &str) -> SyncResult {
        let Some(remote) = self.remote.clone() else {
            return SyncResult {
                status: SyncStatus::Error,
                message: "No remote configured.".to_string(),
            };
        };

        match self.push_inner(&remote) {
            Ok(()) => {
                self.pending_conflict = None;
                SyncResult {
                    status: SyncStatus::Synced,
                    message: "Synced — pushed successfully.".to_string(),
                }
            }
            Err(PushError::Rejected(_)) => match self.pull_inner(&remote, author_name, author_email) {
                Ok(PullOutcome::Conflict) => SyncResult {
                    status: SyncStatus::Conflict,
                    message: self.conflict_message(),
                },
                Ok(_) => match self.push_inner(&remote) {
                    Ok(()) => {
                        self.pending_conflict = None;
                        SyncResult {
                            status: SyncStatus::Synced,
                            message: "Synced — merged remote changes and pushed.".to_string(),
                        }
                    }
                    Err(PushError::Rejected(message)) => SyncResult {
                        status: SyncStatus::Conflict,
                        message: format!("Remote moved again mid-sync — try again ({message})."),
                    },
                    Err(PushError::Git(error)) => classify_sync_error(&error),
                },
                Err(error) => classify_sync_error(&error),
            },
            Err(PushError::Git(error)) => classify_sync_error(&error),
        }
    }

    fn push_inner(&self, remote: &RemoteConfig) -> Result<(), PushError> {
        let branch_name = self.current_branch_name()?;
        let mut git_remote = self.repo.remote_anonymous(&remote.url)?;

        // A rejected update (e.g. the remote has diverged and this isn't a fast-forward) can
        // surface two different ways, confirmed empirically against a real diverged remote:
        // for a local-transport remote, libgit2 detects it client-side and Remote::push itself
        // returns Err with ErrorCode::NotFastForward — the callback below never even fires. For
        // a remote that only rejects server-side (after attempting the transfer), push_update_
        // reference is the only place it's reported, receiving Some(message) per rejected ref
        // instead of an Err at all. Both are handled so neither rejection path is silently
        // treated as success.
        let rejection: std::rc::Rc<std::cell::RefCell<Option<String>>> = std::rc::Rc::new(std::cell::RefCell::new(None));
        let rejection_handle = rejection.clone();
        let mut callbacks = Self::remote_callbacks(remote);
        callbacks.push_update_reference(move |_refname, status| {
            if let Some(message) = status {
                *rejection_handle.borrow_mut() = Some(message.to_string());
            }
            Ok(())
        });

        let mut push_options = git2::PushOptions::new();
        push_options.remote_callbacks(callbacks);

        let refspec = format!("refs/heads/{branch_name}:refs/heads/{branch_name}");
        match git_remote.push(&[refspec.as_str()], Some(&mut push_options)) {
            Ok(()) => {}
            Err(error) if error.code() == git2::ErrorCode::NotFastForward => {
                return Err(PushError::Rejected(error.message().to_string()));
            }
            Err(error) => return Err(PushError::Git(error)),
        }

        if let Some(message) = rejection.borrow_mut().take() {
            return Err(PushError::Rejected(message));
        }
        Ok(())
    }

    /// Resolves a real merge conflict from the most recent pull/push attempt (see
    /// `pending_conflict`) by picking, per conflicted file, whichever side to keep — "mine" (the
    /// local, pre-merge content) or "theirs" (the fetched remote content). Deliberately doesn't
    /// support hand-editing a merged result; a full diff/merge editor is out of scope for v1
    /// (#13). Every conflicted file must be covered by `resolutions` — a partial resolution is
    /// rejected rather than silently committing a still-broken merge.
    ///
    /// Redoes the exact same 3-way merge that produced the conflict: the fetched commit's
    /// objects are still in the local object database (nothing prunes them mid-session), so
    /// merging against the same oid again reproduces the identical conflicted index
    /// deterministically, without needing to have stashed it earlier.
    pub fn resolve_conflict(
        &mut self,
        resolutions: &[ConflictResolution],
        author_name: &str,
        author_email: &str,
    ) -> Result<(), RepoError> {
        let pending = self
            .pending_conflict
            .clone()
            .ok_or_else(|| RepoError::ConflictResolutionFailed("no conflict is pending".to_string()))?;

        let resolved: std::collections::HashSet<&str> = resolutions.iter().map(|r| r.path.as_str()).collect();
        if pending.files.iter().any(|file| !resolved.contains(file.as_str())) {
            return Err(RepoError::ConflictResolutionFailed(
                "every conflicted file must be resolved".to_string(),
            ));
        }

        let fetch_commit = self.repo.find_annotated_commit(pending.fetch_commit_oid)?;
        self.repo.merge(&[&fetch_commit], None, None)?;
        let mut index = self.repo.index()?;
        let conflicts: Vec<git2::IndexConflict> = index.conflicts()?.filter_map(|c| c.ok()).collect();

        for resolution in resolutions {
            let Some(conflict) = conflicts.iter().find(|conflict| Self::conflict_has_path(conflict, &resolution.path)) else {
                continue; // not actually a conflicted path — nothing to do
            };

            let chosen = match resolution.keep {
                ConflictSide::Mine => conflict.our.as_ref(),
                ConflictSide::Theirs => conflict.their.as_ref(),
            };

            match chosen {
                Some(entry) => {
                    let blob = self.repo.find_blob(entry.id)?;
                    let target = self.workdir.join(&resolution.path);
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&target, blob.content())?;
                    index.add_path(Path::new(&resolution.path))?;
                }
                None => {
                    // The chosen side deleted this file.
                    let _ = std::fs::remove_file(self.workdir.join(&resolution.path));
                    let _ = index.remove_path(Path::new(&resolution.path));
                }
            }
        }

        if index.has_conflicts() {
            self.repo.cleanup_state()?;
            self.repo
                .checkout_head(Some(git2::build::CheckoutBuilder::default().force()))?;
            return Err(RepoError::ConflictResolutionFailed(
                "resolution left unresolved conflicts".to_string(),
            ));
        }

        index.write()?;
        let tree_oid = index.write_tree()?;
        let tree = self.repo.find_tree(tree_oid)?;
        let signature = git2::Signature::now(author_name, author_email)?;
        let head_commit = self.repo.head()?.peel_to_commit()?;
        let fetch_commit_obj = self.repo.find_commit(pending.fetch_commit_oid)?;
        self.repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Merge remote changes (resolved conflict)",
            &tree,
            &[&head_commit, &fetch_commit_obj],
        )?;
        self.repo.cleanup_state()?;
        self.pending_conflict = None;
        Ok(())
    }

    fn conflict_has_path(conflict: &git2::IndexConflict, path: &str) -> bool {
        let matches = |entry: &Option<git2::IndexEntry>| {
            entry.as_ref().is_some_and(|entry| entry.path == path.as_bytes())
        };
        matches(&conflict.our) || matches(&conflict.their) || matches(&conflict.ancestor)
    }
}

enum PushError {
    /// The remote rejected the update (e.g. a non-fast-forward — local and remote have
    /// diverged), reported via a callback rather than as a git2::Error — see push_inner.
    Rejected(String),
    Git(git2::Error),
}

impl From<git2::Error> for PushError {
    fn from(error: git2::Error) -> Self {
        PushError::Git(error)
    }
}

enum PullOutcome {
    UpToDate,
    FastForwarded,
    Merged(String),
    Conflict,
}

fn classify_sync_error(error: &git2::Error) -> SyncResult {
    if is_network_unreachable(error) {
        return SyncResult {
            status: SyncStatus::Offline,
            message: "Offline — local changes are saved and will sync once back online.".to_string(),
        };
    }
    SyncResult {
        status: SyncStatus::Error,
        message: error.message().to_string(),
    }
}

/// A real HTTP response (even an error one, e.g. a 401 or 404) reaching the server means we're
/// not offline — that surfaces as `ErrorClass::Http`, distinct from a connection never being
/// established at all. Confirmed empirically (not just from docs) that libgit2 doesn't use one
/// consistent class for every pre-HTTP transport failure: a DNS resolution failure surfaces as
/// `ErrorClass::Net`, but a TCP connect failure (e.g. connection refused) surfaces as
/// `ErrorClass::Os` with a connection-related message instead. Both mean the same thing here —
/// no network reachable — so both are treated as offline; other `Os`-classed errors are not
/// (matched by message content, a known-imperfect but practically reliable heuristic).
fn is_network_unreachable(error: &git2::Error) -> bool {
    match error.class() {
        git2::ErrorClass::Net => true,
        git2::ErrorClass::Os => {
            let message = error.message().to_ascii_lowercase();
            ["connect", "resolve", "unreachable", "timed out"]
                .iter()
                .any(|keyword| message.contains(keyword))
        }
        _ => false,
    }
}
