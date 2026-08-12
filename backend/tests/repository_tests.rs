use std::path::Path;

use todowai_backend::repository::{ChangeType, Repository};

fn init_seeded_repo(dir: &Path) {
    let repo = git2::Repository::init(dir).unwrap();
    std::fs::write(dir.join("notes.md"), "# Notes").unwrap();
    std::fs::create_dir_all(dir.join("todowai")).unwrap();
    std::fs::write(dir.join("todowai/task.md"), "- [ ] one").unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(Path::new("notes.md")).unwrap();
    index.add_path(Path::new("todowai/task.md")).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let signature = git2::Signature::now("Seed", "seed@example.invalid").unwrap();
    repo.commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
        .unwrap();
}

#[test]
fn fresh_repo_has_no_history_and_empty_status() {
    let temp = tempfile::tempdir().unwrap();
    git2::Repository::init(temp.path()).unwrap();

    let repository = Repository::open(temp.path()).unwrap();
    let snapshot = repository.snapshot().unwrap();

    assert!(snapshot.history.is_empty());
    assert!(snapshot.pending_changes.is_empty());
    assert!(snapshot.files.is_empty());
}

#[test]
fn detects_added_modified_and_deleted_files() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    // Modify a tracked file, delete another, and add a brand new one.
    repository.write_file("notes.md", "# Notes\n\nUpdated").unwrap();
    std::fs::remove_file(temp.path().join("todowai/task.md")).unwrap();
    repository.write_file("todowai/new.md", "new content").unwrap();

    let snapshot = repository.snapshot().unwrap();
    let find = |path: &str| {
        snapshot
            .pending_changes
            .iter()
            .find(|change| change.filepath == path)
            .unwrap_or_else(|| panic!("expected a pending change for {path}"))
    };

    assert_eq!(find("notes.md").change_type, ChangeType::Modified);
    assert_eq!(find("todowai/task.md").change_type, ChangeType::Deleted);
    assert_eq!(find("todowai/new.md").change_type, ChangeType::Added);
}

#[test]
fn commit_all_stages_and_commits_every_pending_change_including_deletions() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    repository.write_file("notes.md", "# Notes\n\nUpdated").unwrap();
    std::fs::remove_file(temp.path().join("todowai/task.md")).unwrap();

    let result = repository
        .commit_all("feat: update notes", "Todowai User", "todowai@example.invalid")
        .unwrap();

    assert_eq!(result.oid.len(), 40);
    assert!(result.pending_changes.is_empty());
    assert!(!result.files.contains(&"todowai/task.md".to_string()));

    let history = repository.recent_history(10).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].message, "feat: update notes");
    assert_eq!(history[0].author_name, "Todowai User");
}

#[test]
fn commit_all_rejects_when_nothing_is_pending() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    let result = repository.commit_all("feat: no-op", "Todowai User", "todowai@example.invalid");

    assert!(result.is_err());
}

#[test]
fn write_file_rejects_path_traversal() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    let result = repository.write_file("../outside.md", "escape attempt");

    assert!(result.is_err());
    assert!(!temp.path().parent().unwrap().join("outside.md").exists());
}

#[test]
fn read_file_rejects_missing_file() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    let result = repository.read_file("does-not-exist.md");

    assert!(result.is_err());
}

#[test]
fn list_files_excludes_git_internals() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    let files = repository.list_files().unwrap();

    assert!(files.iter().all(|path| !path.starts_with(".git")));
    assert!(files.contains(&"notes.md".to_string()));
    assert!(files.contains(&"todowai/task.md".to_string()));
}
