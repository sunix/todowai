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

// A real vault can contain non-text files (e.g. images pasted into Obsidian notes) alongside
// markdown — reading one back should be a clean client-facing error, not a raw IO failure.
#[test]
fn read_file_of_a_binary_file_is_not_a_generic_io_error() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    std::fs::write(temp.path().join("image.png"), [0xFFu8, 0xD8, 0xFF, 0x00, 0x10]).unwrap();
    let repository = Repository::open(temp.path()).unwrap();

    let result = repository.read_file("image.png");

    assert!(matches!(result, Err(todowai_backend::error::RepoError::NotText(_))));
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

#[test]
fn list_configured_remotes_is_empty_with_no_remotes() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    let remotes = repository.list_configured_remotes().unwrap();

    assert!(remotes.is_empty());
}

#[test]
fn list_configured_remotes_reads_existing_git_config_remotes() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let git_repo = git2::Repository::open(temp.path()).unwrap();
    git_repo.remote("origin", "https://example.invalid/notes.git").unwrap();
    git_repo.remote("backup", "https://backup.invalid/notes.git").unwrap();
    let repository = Repository::open(temp.path()).unwrap();

    let remotes = repository.list_configured_remotes().unwrap();

    assert_eq!(remotes.len(), 2);
    let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
    assert_eq!(origin.url, "https://example.invalid/notes.git");
    let backup = remotes.iter().find(|r| r.name == "backup").unwrap();
    assert_eq!(backup.url, "https://backup.invalid/notes.git");
}

#[test]
fn obsidian_and_git_paths_are_rejected_for_read_and_write() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    std::fs::create_dir_all(temp.path().join(".obsidian")).unwrap();
    std::fs::write(temp.path().join(".obsidian/workspace.json"), "{}").unwrap();
    let repository = Repository::open(temp.path()).unwrap();

    assert!(repository.read_file(".obsidian/workspace.json").is_err());
    assert!(repository.read_file(".git/config").is_err());
    assert!(repository
        .write_file(".obsidian/workspace.json", "tampered")
        .is_err());
    // Case-insensitivity, matching how these names actually appear across filesystems.
    assert!(repository.read_file(".OBSIDIAN/workspace.json").is_err());

    // Untouched by the rejected write attempt.
    assert_eq!(
        std::fs::read_to_string(temp.path().join(".obsidian/workspace.json")).unwrap(),
        "{}"
    );
}

#[test]
fn obsidian_and_git_paths_never_appear_in_files_or_status() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    std::fs::create_dir_all(temp.path().join(".obsidian")).unwrap();
    std::fs::write(temp.path().join(".obsidian/workspace.json"), "{}").unwrap();
    let repository = Repository::open(temp.path()).unwrap();

    let snapshot = repository.snapshot().unwrap();

    assert!(!snapshot
        .files
        .iter()
        .any(|path| path.to_ascii_lowercase().starts_with(".obsidian")));
    assert!(!snapshot
        .pending_changes
        .iter()
        .any(|change| change.filepath.to_ascii_lowercase().starts_with(".obsidian")));
}

#[test]
fn editing_existing_file_outside_subfolder_succeeds() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    // notes.md is outside the default "todowai" subfolder but already tracked.
    let result = repository.write_file("notes.md", "# Notes\n\nEdited from outside the subfolder");

    assert!(result.is_ok());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("notes.md")).unwrap(),
        "# Notes\n\nEdited from outside the subfolder"
    );
}

#[test]
fn creating_new_file_outside_subfolder_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    let result = repository.write_file("brand-new.md", "should not be allowed here");

    assert!(result.is_err());
    assert!(!temp.path().join("brand-new.md").exists());
}

#[test]
fn commit_all_does_not_stage_a_deletion_outside_the_subfolder() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    // notes.md (outside "todowai/") deleted by some other tool; a real edit inside the
    // subfolder gives commit_all something manageable to actually commit.
    std::fs::remove_file(temp.path().join("notes.md")).unwrap();
    repository.write_file("todowai/task.md", "- [x] one").unwrap();

    let result = repository
        .commit_all("feat: update task", "Todowai User", "todowai@example.invalid")
        .unwrap();

    // The external deletion was deliberately left uncommitted, so it's still a pending change.
    assert!(result
        .pending_changes
        .iter()
        .any(|change| change.filepath == "notes.md" && change.change_type == ChangeType::Deleted));
    // ...while the manageable in-subfolder edit was committed.
    assert!(!result
        .pending_changes
        .iter()
        .any(|change| change.filepath == "todowai/task.md"));
}

#[test]
fn commit_all_does_not_stage_a_new_file_outside_the_subfolder() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let repository = Repository::open(temp.path()).unwrap();

    // A file appearing outside the subfolder via some other tool, not through write_file.
    std::fs::write(temp.path().join("external.md"), "not from Todowai").unwrap();
    repository.write_file("todowai/task.md", "- [x] one").unwrap();

    let result = repository
        .commit_all("feat: update task", "Todowai User", "todowai@example.invalid")
        .unwrap();

    assert!(result
        .pending_changes
        .iter()
        .any(|change| change.filepath == "external.md" && change.change_type == ChangeType::Added));
}

#[test]
fn set_subfolder_trims_slashes_and_falls_back_to_default() {
    let temp = tempfile::tempdir().unwrap();
    init_seeded_repo(temp.path());
    let mut repository = Repository::open(temp.path()).unwrap();

    repository.set_subfolder("  /custom/  ");
    assert_eq!(repository.subfolder(), "custom");

    repository.set_subfolder("   ");
    assert_eq!(repository.subfolder(), "todowai");
}
