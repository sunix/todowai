use std::collections::HashMap;

use serde::{Deserialize, Serialize};

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
    /// 0-100, clamped; missing or unparsable defaults to 0.
    pub progress: u8,
    /// The first non-empty line of the note's body, or empty if there isn't one — the card's
    /// short description line, mirroring the mockup's "meta" text under each project name.
    pub meta: String,
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
    let progress = fields
        .get("progress")
        .and_then(|value| value.parse::<i32>().ok())
        .map(|value| value.clamp(0, 100) as u8)
        .unwrap_or(0);
    let meta = body.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim().to_string();

    Some(Project { path: path.to_string(), name: display_name(path), status, progress, meta })
}

/// A minimal YAML-frontmatter subset reader — just scalar `key: value` lines plus the body,
/// not a general-purpose parser (mirrors the frontend's app/src/frontmatter.ts, #18). Scoped
/// separately from ai.rs's parse_status rather than sharing it, since that function is already
/// merged/tested for a different specific shape (situational/task kind) and unifying the two
/// isn't needed for this to work correctly — a reasonable future cleanup, not a blocker here.
fn parse_frontmatter_fields(raw: &str) -> (HashMap<String, String>, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return (HashMap::new(), raw.trim().to_string());
    }

    let mut lines = trimmed.lines();
    lines.next();
    let mut fields = HashMap::new();
    for line in lines.by_ref() {
        if line.trim() == "---" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    let body: String = lines.collect::<Vec<_>>().join("\n");
    (fields, body.trim().to_string())
}

/// Notes don't carry an explicit title field today — derives a readable name from the filename
/// instead: strips a leading `YYYY-MM-DD-` date prefix (the project's own convention for filed
/// notes, see #16/#17) and the `.md` extension, then title-cases the remaining dash-separated
/// slug (e.g. "2026-08-10-client-x-migration.md" -> "Client X Migration").
fn display_name(path: &str) -> String {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let without_ext = file_name.strip_suffix(".md").unwrap_or(file_name);
    let without_date = strip_date_prefix(without_ext);

    without_date
        .split('-')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut chars = segment.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_date_prefix(slug: &str) -> &str {
    let bytes = slug.as_bytes();
    let has_date_prefix = bytes.len() > 11
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[10] == b'-';
    if has_date_prefix {
        &slug[11..]
    } else {
        slug
    }
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
    fn display_name_strips_date_prefix_and_title_cases() {
        assert_eq!(display_name("todowai/backlog/2026-08-10-client-x-migration.md"), "Client X Migration");
        assert_eq!(display_name("karasun-side-project.md"), "Karasun Side Project");
    }

    #[test]
    fn display_name_without_a_date_prefix_is_unaffected() {
        assert_eq!(display_name("todowai/backlog/spec-cleanup.md"), "Spec Cleanup");
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
}
