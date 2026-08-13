use std::path::Path;

use todowai_backend::repository::{RemoteConfig, Repository, SyncStatus};

fn init_repo_with_branch(dir: &Path, bare: bool, branch: &str) -> git2::Repository {
    let mut opts = git2::RepositoryInitOptions::new();
    opts.bare(bare).initial_head(branch);
    git2::Repository::init_opts(dir, &opts).unwrap()
}

/// Commits a file directly via the object database — works for both bare and non-bare repos,
/// so a "remote" can get new commits without ever needing a working directory of its own.
fn commit_file(repo: &git2::Repository, parent: Option<&git2::Commit>, filename: &str, content: &str, message: &str) -> git2::Oid {
    let blob_oid = repo.blob(content.as_bytes()).unwrap();
    let mut tree_builder = repo.treebuilder(parent.map(|p| p.tree().unwrap()).as_ref()).unwrap();
    tree_builder.insert(filename, blob_oid, 0o100644).unwrap();
    let tree_oid = tree_builder.write().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let signature = git2::Signature::now("Remote Seed", "remote@example.invalid").unwrap();
    let parents: Vec<&git2::Commit> = parent.into_iter().collect();
    repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents).unwrap()
}

const BRANCH: &str = "main";

fn init_bare_remote_with_commit(dir: &Path) -> (git2::Repository, git2::Oid) {
    let repo = init_repo_with_branch(dir, true, BRANCH);
    let oid = commit_file(&repo, None, "shared.md", "v1", "seed");
    (repo, oid)
}

fn clone_local(remote_dir: &Path, local_dir: &Path) -> Repository {
    git2::build::RepoBuilder::new().clone(&remote_dir.display().to_string(), local_dir).unwrap();
    Repository::open(local_dir).unwrap()
}

fn remote_config(dir: &Path) -> RemoteConfig {
    RemoteConfig {
        url: dir.display().to_string(),
        username: String::new(),
        token: String::new(),
    }
}

#[test]
fn pull_and_push_report_error_with_no_remote_configured() {
    let temp = tempfile::tempdir().unwrap();
    let (_remote_repo, _oid) = init_bare_remote_with_commit(temp.path());
    let local_dir = tempfile::tempdir().unwrap();
    let repository = clone_local(temp.path(), local_dir.path());

    let pull_result = repository.pull("Todowai Sync", "sync@example.invalid");
    assert_eq!(pull_result.status, SyncStatus::Error);
    assert_eq!(pull_result.message, "No remote configured.");

    let push_result = repository.push();
    assert_eq!(push_result.status, SyncStatus::Error);
    assert_eq!(push_result.message, "No remote configured.");
}

#[test]
fn pull_fast_forwards_when_remote_has_new_commits() {
    let remote_dir = tempfile::tempdir().unwrap();
    let (remote_repo, first_oid) = init_bare_remote_with_commit(remote_dir.path());
    let local_dir = tempfile::tempdir().unwrap();
    let mut repository = clone_local(remote_dir.path(), local_dir.path());
    repository.set_remote(Some(remote_config(remote_dir.path())));

    // The remote gets a second commit the local clone doesn't have yet.
    let first_commit = remote_repo.find_commit(first_oid).unwrap();
    commit_file(&remote_repo, Some(&first_commit), "shared.md", "v2", "update from remote");

    let result = repository.pull("Todowai Sync", "sync@example.invalid");

    assert_eq!(result.status, SyncStatus::Synced);
    assert_eq!(
        std::fs::read_to_string(local_dir.path().join("shared.md")).unwrap(),
        "v2",
        "the fast-forwarded working tree should reflect the remote's new content"
    );
    assert_eq!(repository.recent_history(10).unwrap().len(), 2);
}

#[test]
fn pull_reports_up_to_date_when_nothing_changed() {
    let remote_dir = tempfile::tempdir().unwrap();
    init_bare_remote_with_commit(remote_dir.path());
    let local_dir = tempfile::tempdir().unwrap();
    let mut repository = clone_local(remote_dir.path(), local_dir.path());
    repository.set_remote(Some(remote_config(remote_dir.path())));

    let result = repository.pull("Todowai Sync", "sync@example.invalid");

    assert_eq!(result.status, SyncStatus::Synced);
    assert_eq!(result.message, "Already up to date.");
}

#[test]
fn pull_reports_offline_when_remote_is_unreachable() {
    let local_dir = tempfile::tempdir().unwrap();
    let repo = init_repo_with_branch(local_dir.path(), false, BRANCH);
    commit_file(&repo, None, "notes.md", "hello", "seed");
    let mut repository = Repository::open(local_dir.path()).unwrap();
    // Port 1 is a reserved, essentially always-unbound port — connection should be refused
    // immediately rather than hang, giving a fast, deterministic "no network" classification.
    repository.set_remote(Some(RemoteConfig {
        url: "http://127.0.0.1:1/nonexistent.git".to_string(),
        username: String::new(),
        token: String::new(),
    }));

    let result = repository.pull("Todowai Sync", "sync@example.invalid");

    assert_eq!(
        result.status,
        SyncStatus::Offline,
        "expected an unreachable host to classify as offline, got: {result:?}"
    );
}

#[test]
fn pull_reports_conflict_and_leaves_local_state_clean_when_histories_diverge_incompatibly() {
    let remote_dir = tempfile::tempdir().unwrap();
    let (remote_repo, first_oid) = init_bare_remote_with_commit(remote_dir.path());
    let local_dir = tempfile::tempdir().unwrap();
    let mut repository = clone_local(remote_dir.path(), local_dir.path());
    repository.set_remote(Some(remote_config(remote_dir.path())));

    // Remote and local both change the exact same file's only line, differently.
    let first_commit = remote_repo.find_commit(first_oid).unwrap();
    commit_file(&remote_repo, Some(&first_commit), "shared.md", "v2-remote", "remote change");
    repository.write_file("shared.md", "v2-local").unwrap();
    let local_result = repository
        .commit_all("feat: local change", "Todowai User", "todowai@example.invalid")
        .unwrap();

    let result = repository.pull("Todowai Sync", "sync@example.invalid");

    assert_eq!(result.status, SyncStatus::Conflict);
    // Local work is untouched: the file still has the local content, not conflict markers, and
    // the local commit is still there.
    assert_eq!(std::fs::read_to_string(local_dir.path().join("shared.md")).unwrap(), "v2-local");
    assert_eq!(repository.recent_history(10).unwrap()[0].oid, local_result.oid);
    assert!(repository.snapshot().unwrap().pending_changes.is_empty(), "the aborted merge shouldn't leave stray pending changes");
}

#[test]
fn push_updates_the_remote() {
    let remote_dir = tempfile::tempdir().unwrap();
    init_bare_remote_with_commit(remote_dir.path());
    let local_dir = tempfile::tempdir().unwrap();
    let mut repository = clone_local(remote_dir.path(), local_dir.path());
    repository.set_remote(Some(remote_config(remote_dir.path())));

    repository.write_file("todowai/local.md", "new content").unwrap();
    let commit_result = repository
        .commit_all("feat: add local note", "Todowai User", "todowai@example.invalid")
        .unwrap();

    let result = repository.push();

    assert_eq!(result.status, SyncStatus::Synced);
    let remote_repo = git2::Repository::open_bare(remote_dir.path()).unwrap();
    let remote_head = remote_repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(remote_head.id().to_string(), commit_result.oid);
}

#[test]
fn push_reports_conflict_when_remote_has_diverged() {
    let remote_dir = tempfile::tempdir().unwrap();
    let (remote_repo, first_oid) = init_bare_remote_with_commit(remote_dir.path());
    let local_dir = tempfile::tempdir().unwrap();
    let mut repository = clone_local(remote_dir.path(), local_dir.path());
    repository.set_remote(Some(remote_config(remote_dir.path())));

    // The remote moves on without the local clone knowing.
    let first_commit = remote_repo.find_commit(first_oid).unwrap();
    commit_file(&remote_repo, Some(&first_commit), "shared.md", "v2-remote", "remote change");

    // Local makes its own independent commit and tries to push without pulling first.
    repository.write_file("todowai/local.md", "new content").unwrap();
    repository
        .commit_all("feat: add local note", "Todowai User", "todowai@example.invalid")
        .unwrap();

    let result = repository.push();

    assert_eq!(result.status, SyncStatus::Conflict);
}
