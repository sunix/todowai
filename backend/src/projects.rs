use serde::{Deserialize, Serialize};

use crate::note::{display_name, parse_frontmatter_fields};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    /// Derived from the filename (see display_name) — notes don't carry an explicit title
    /// field today, matching how the rest of the app treats filenames elsewhere.
    pub name: String,
    /// The raw frontmatter value (e.g. "blocked", "in-progress", "ai-delegated") — the
    /// frontend maps a small known set to badge styling and falls back gracefully for
    /// anything else, so this stays free text rather than a fixed enum here.
    pub status: String,
    /// Derived from completed/total tasks when the note has any (see derive_progress); falls
    /// back to the frontmatter `progress:` field for a project with no checklist yet — a
    /// non-breaking fallback for notes written before #95.
    pub progress: u8,
    /// The first non-empty, non-checklist line of the note's body, or empty if there isn't
    /// one — the card's short description line, mirroring the mockup's "meta" text.
    pub meta: String,
    /// Parsed from plain `- [ ]`/`- [x]` markdown checkboxes in the body — Obsidian's own
    /// native task convention, not new frontmatter (#95).
    #[serde(default)]
    pub tasks: Vec<ProjectTask>,
}

/// A read-only projection over whatever notes already carry `type: project` frontmatter — the
/// markdown files stay the single source of truth; this never writes anything back.
pub fn scan_projects(files: &[(String, String)]) -> Vec<Project> {
    files.iter().filter_map(|(path, content)| parse_project(path, content)).collect()
}

fn parse_project(path: &str, content: &str) -> Option<Project> {
    let (fields, body) = parse_frontmatter_fields(content);
    if fields.get("type").map(String::as_str) != Some("project") {
        return None;
    }

    let status = fields.get("status").cloned().unwrap_or_else(|| "backlog".to_string());
    let fallback_progress = fields
        .get("progress")
        .and_then(|value| value.parse::<i32>().ok())
        .map(|value| value.clamp(0, 100) as u8)
        .unwrap_or(0);

    let tasks = parse_tasks(&body);
    let progress = derive_progress(&tasks, fallback_progress);
    let meta = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && parse_task_line(line).is_none())
        .unwrap_or("")
        .to_string();

    Some(Project { path: path.to_string(), name: display_name(path), status, progress, meta, tasks })
}

fn parse_task_line(line: &str) -> Option<(&str, bool)> {
    line.strip_prefix("- [ ] ")
        .map(|rest| (rest, false))
        .or_else(|| line.strip_prefix("- [x] ").map(|rest| (rest, true)))
        .or_else(|| line.strip_prefix("- [X] ").map(|rest| (rest, true)))
}

fn parse_tasks(body: &str) -> Vec<ProjectTask> {
    body.lines()
        .filter_map(|line| {
            let (text, done) = parse_task_line(line.trim())?;
            Some(ProjectTask { text: text.trim().to_string(), done })
        })
        .collect()
}

/// Rounds to the nearest whole percent — e.g. 1 of 3 done is 33%, not 0% (truncating) or a
/// misleadingly precise fraction.
fn derive_progress(tasks: &[ProjectTask], fallback: u8) -> u8 {
    if tasks.is_empty() {
        return fallback;
    }
    let done = tasks.iter().filter(|task| task.done).count();
    ((done as f64 / tasks.len() as f64) * 100.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_project_note_with_all_fields() {
        let content = "---\ntype: project\nstatus: blocked\nprogress: 20\n---\n\nWaiting on external API keys.";
        let project = parse_project("todowai/backlog/2026-08-10-client-x-migration.md", content).unwrap();
        assert_eq!(project.name, "Client X Migration");
        assert_eq!(project.status, "blocked");
        assert_eq!(project.progress, 20);
        assert_eq!(project.meta, "Waiting on external API keys.");
    }

    #[test]
    fn ignores_notes_that_are_not_type_project() {
        let content = "---\ntype: todo\nstatus: backlog\n---\n\nJust a todo.";
        assert!(parse_project("todowai/backlog/todo.md", content).is_none());
    }

    #[test]
    fn missing_status_and_progress_fall_back_to_defaults() {
        let content = "---\ntype: project\n---\n\nNo status or progress set.";
        let project = parse_project("todowai/backlog/no-status.md", content).unwrap();
        assert_eq!(project.status, "backlog");
        assert_eq!(project.progress, 0);
    }

    #[test]
    fn progress_out_of_range_is_clamped() {
        let content = "---\ntype: project\nprogress: 500\n---\n\nBody";
        let project = parse_project("todowai/backlog/over.md", content).unwrap();
        assert_eq!(project.progress, 100);
    }

    #[test]
    fn non_numeric_progress_falls_back_to_zero_rather_than_erroring() {
        let content = "---\ntype: project\nprogress: not-a-number\n---\n\nBody";
        let project = parse_project("todowai/backlog/bad.md", content).unwrap();
        assert_eq!(project.progress, 0);
    }

    #[test]
    fn meta_skips_leading_blank_lines_in_the_body() {
        let content = "---\ntype: project\n---\n\n\n\nFirst real line.\nSecond line.";
        let project = parse_project("todowai/backlog/x.md", content).unwrap();
        assert_eq!(project.meta, "First real line.");
    }

    #[test]
    fn parses_a_task_checklist_and_derives_progress_from_it() {
        let content = "---\ntype: project\nprogress: 99\n---\n\n- [x] Find a date\n- [ ] Book the venue\n- [ ] Invite speakers";
        let project = parse_project("todowai/backlog/parisjug.md", content).unwrap();
        assert_eq!(project.tasks.len(), 3);
        assert_eq!(project.tasks[0], ProjectTask { text: "Find a date".to_string(), done: true });
        assert_eq!(project.tasks[1], ProjectTask { text: "Book the venue".to_string(), done: false });
        // Derived from 1/3 done, not the stale frontmatter progress field.
        assert_eq!(project.progress, 33);
    }

    #[test]
    fn capital_x_marks_a_task_done_too() {
        let content = "---\ntype: project\n---\n\n- [X] Done with capital X";
        let project = parse_project("todowai/backlog/x.md", content).unwrap();
        assert!(project.tasks[0].done);
    }

    #[test]
    fn no_checklist_falls_back_to_the_frontmatter_progress_field() {
        let content = "---\ntype: project\nprogress: 45\n---\n\nJust a description, no tasks.";
        let project = parse_project("todowai/backlog/x.md", content).unwrap();
        assert!(project.tasks.is_empty());
        assert_eq!(project.progress, 45);
    }

    #[test]
    fn all_tasks_done_is_full_progress() {
        let content = "---\ntype: project\n---\n\n- [x] One\n- [x] Two";
        let project = parse_project("todowai/backlog/x.md", content).unwrap();
        assert_eq!(project.progress, 100);
    }

    #[test]
    fn meta_skips_checklist_lines_to_find_the_description() {
        let content = "---\ntype: project\n---\n\n- [ ] Find a date\n- [x] Book the venue\nActual description here.";
        let project = parse_project("todowai/backlog/x.md", content).unwrap();
        assert_eq!(project.meta, "Actual description here.");
    }

    #[test]
    fn meta_is_empty_when_the_body_is_only_a_checklist() {
        let content = "---\ntype: project\n---\n\n- [ ] Only a task, no description";
        let project = parse_project("todowai/backlog/x.md", content).unwrap();
        assert_eq!(project.meta, "");
    }

    #[test]
    fn scan_projects_skips_non_project_notes_and_keeps_the_rest() {
        let files = vec![
            ("todowai/backlog/a.md".to_string(), "---\ntype: project\nstatus: done\n---\n\nShipped.".to_string()),
            ("todowai/backlog/b.md".to_string(), "---\ntype: todo\n---\n\nNot a project.".to_string()),
        ];
        let projects = scan_projects(&files);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].status, "done");
    }

    // A project promoted to a folder-note (#111/ADR-003) is discovered exactly like a flat
    // project note — the only difference is display_name deriving the title from the folder.
    #[test]
    fn a_project_promoted_to_a_folder_with_index_md_is_discovered_and_named_from_its_folder() {
        let content = "---\ntype: project\nstatus: in-progress\n---\n\nParisJUG chez Sciam event.";
        let project = parse_project("todowai/backlog/parisjug/index.md", content).unwrap();
        assert_eq!(project.name, "Parisjug");
        assert_eq!(project.status, "in-progress");
    }

    // Sibling notes placed inside a project's folder are still independently discoverable by
    // whichever scanner cares about their own type (this one doesn't scan for `type: project`,
    // so it correctly ignores them) — the crux of #111's "grouped, not a separate manifest".
    #[test]
    fn scan_projects_ignores_sibling_notes_in_a_projects_folder_that_are_not_projects_themselves() {
        let files = vec![
            ("todowai/backlog/parisjug/index.md".to_string(), "---\ntype: project\n---\n\nEvent.".to_string()),
            ("todowai/backlog/parisjug/find-a-date.md".to_string(), "---\ntype: todo\n---\n\nFind a date.".to_string()),
            (
                "todowai/backlog/parisjug/kickoff.md".to_string(),
                "---\ntype: meeting\n---\n\nKickoff notes.".to_string(),
            ),
        ];
        let projects = scan_projects(&files);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Parisjug");
    }
}
