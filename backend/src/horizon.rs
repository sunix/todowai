use serde::{Deserialize, Serialize};

use crate::note::{display_name, parse_frontmatter_fields};

/// Only the horizon values the frontend actually groups by — anything else in a note's
/// `horizon:` field (a typo, an old value) is treated the same as it being unset, since silently
/// inventing a fourth column for garbage input would be more confusing than falling back.
const KNOWN_HORIZONS: [&str; 3] = ["week", "month", "year"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HorizonItem {
    pub path: String,
    /// Derived from the filename, same convention as Project::name (#25) — notes don't carry an
    /// explicit title field.
    pub name: String,
    /// "todo" | "project" — the only two frontmatter types this view groups (#26); meetings and
    /// status notes have no notion of a planning horizon.
    pub kind: String,
    /// "week" | "month" | "year", or "" when the note has never been assigned one — the frontend
    /// renders that as its own "Unscheduled" column rather than guessing a default, since
    /// silently sorting an existing note into a real horizon would be an unannounced
    /// auto-reorganization the user never asked for (see specification/specs.md's
    /// confirm-before-move guardrail).
    pub horizon: String,
}

/// A read-only projection over whatever notes already carry `type: todo` or `type: project`
/// frontmatter — the markdown files stay the single source of truth; moving an item between
/// horizons happens by writing its `horizon:` field directly (see the frontend's read-modify-write
/// via the generic file endpoints), not through a dedicated mutation here.
pub fn scan_horizon_items(files: &[(String, String)]) -> Vec<HorizonItem> {
    files.iter().filter_map(|(path, content)| parse_horizon_item(path, content)).collect()
}

fn parse_horizon_item(path: &str, content: &str) -> Option<HorizonItem> {
    let (fields, _body) = parse_frontmatter_fields(content);
    let kind = fields.get("type").cloned()?;
    if kind != "todo" && kind != "project" {
        return None;
    }

    let horizon = fields
        .get("horizon")
        .map(String::as_str)
        .filter(|value| KNOWN_HORIZONS.contains(value))
        .unwrap_or("")
        .to_string();

    Some(HorizonItem { path: path.to_string(), name: display_name(path), kind, horizon })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_todo_with_a_horizon() {
        let content = "---\ntype: todo\nhorizon: week\n---\n\nBody.";
        let item = parse_horizon_item("todowai/backlog/2026-08-10-write-report.md", content).unwrap();
        assert_eq!(item.name, "Write Report");
        assert_eq!(item.kind, "todo");
        assert_eq!(item.horizon, "week");
    }

    #[test]
    fn parses_a_project_with_a_horizon() {
        let content = "---\ntype: project\nhorizon: year\n---\n\nBody.";
        let item = parse_horizon_item("todowai/backlog/parisjug.md", content).unwrap();
        assert_eq!(item.kind, "project");
        assert_eq!(item.horizon, "year");
    }

    #[test]
    fn missing_horizon_is_the_empty_string_not_a_guessed_default() {
        let content = "---\ntype: todo\n---\n\nNo horizon set yet.";
        let item = parse_horizon_item("todowai/backlog/x.md", content).unwrap();
        assert_eq!(item.horizon, "");
    }

    #[test]
    fn an_unrecognized_horizon_value_falls_back_to_unset() {
        let content = "---\ntype: todo\nhorizon: someday\n---\n\nBody.";
        let item = parse_horizon_item("todowai/backlog/x.md", content).unwrap();
        assert_eq!(item.horizon, "");
    }

    #[test]
    fn ignores_notes_that_are_not_todo_or_project() {
        let content = "---\ntype: meeting\nhorizon: week\n---\n\nBody.";
        assert!(parse_horizon_item("todowai/backlog/standup.md", content).is_none());
    }

    #[test]
    fn ignores_notes_with_no_type_at_all() {
        assert!(parse_horizon_item("todowai/backlog/x.md", "Just plain text.").is_none());
    }

    #[test]
    fn scan_horizon_items_collects_todos_and_projects_and_skips_the_rest() {
        let files = vec![
            ("a.md".to_string(), "---\ntype: todo\nhorizon: week\n---\n\nA".to_string()),
            ("b.md".to_string(), "---\ntype: project\nhorizon: month\n---\n\nB".to_string()),
            ("c.md".to_string(), "---\ntype: meeting\n---\n\nC".to_string()),
        ];
        let items = scan_horizon_items(&files);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].horizon, "week");
        assert_eq!(items[1].horizon, "month");
    }

    // A project note promoted to a folder (#111/ADR-003) and a task note living alongside it in
    // that same folder are both still discovered independently, each with its own horizon.
    #[test]
    fn scan_horizon_items_finds_a_project_folders_notes_independently() {
        let files = vec![
            ("todowai/backlog/parisjug/index.md".to_string(), "---\ntype: project\nhorizon: month\n---\n\nEvent.".to_string()),
            (
                "todowai/backlog/parisjug/find-a-date.md".to_string(),
                "---\ntype: todo\nhorizon: week\n---\n\nFind a date.".to_string(),
            ),
        ];
        let items = scan_horizon_items(&files);
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|item| item.name == "Parisjug" && item.horizon == "month"));
        assert!(items.iter().any(|item| item.name == "Find A Date" && item.horizon == "week"));
    }
}
