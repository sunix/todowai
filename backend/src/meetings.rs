use serde::{Deserialize, Serialize};

use crate::note::{display_name, parse_frontmatter_fields};

/// A read-only projection over whatever notes already carry `type: meeting` frontmatter (#28) —
/// the markdown note stays the single source of truth; selecting one on the Meetings screen reads
/// its full content (frontmatter and body) via the existing generic file endpoint, not through
/// this struct. Only enough here to list candidates: `date` is the raw frontmatter value, free
/// text (same as Project::status staying free text rather than a fixed enum) and empty when the
/// note has none.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub path: String,
    pub name: String,
    pub date: String,
}

pub fn scan_meetings(files: &[(String, String)]) -> Vec<Meeting> {
    files.iter().filter_map(|(path, content)| parse_meeting(path, content)).collect()
}

fn parse_meeting(path: &str, content: &str) -> Option<Meeting> {
    let (fields, _body) = parse_frontmatter_fields(content);
    if fields.get("type").map(String::as_str) != Some("meeting") {
        return None;
    }

    let date = fields.get("date").cloned().unwrap_or_default();
    Some(Meeting { path: path.to_string(), name: display_name(path), date })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_meeting_note_with_a_date() {
        let content = "---\ntype: meeting\ndate: 2026-08-10\n---\n\nDiscussed Q3 roadmap.";
        let meeting = parse_meeting("todowai/backlog/2026-08-10-standup.md", content).unwrap();
        assert_eq!(meeting.name, "Standup");
        assert_eq!(meeting.date, "2026-08-10");
    }

    #[test]
    fn missing_date_is_the_empty_string() {
        let content = "---\ntype: meeting\n---\n\nNo date set.";
        let meeting = parse_meeting("todowai/backlog/x.md", content).unwrap();
        assert_eq!(meeting.date, "");
    }

    #[test]
    fn ignores_notes_that_are_not_type_meeting() {
        let content = "---\ntype: todo\ndate: 2026-08-10\n---\n\nNot a meeting.";
        assert!(parse_meeting("todowai/backlog/x.md", content).is_none());
    }

    #[test]
    fn ignores_notes_with_no_type_at_all() {
        assert!(parse_meeting("todowai/backlog/x.md", "Just plain text.").is_none());
    }

    #[test]
    fn scan_meetings_collects_meetings_and_skips_the_rest() {
        let files = vec![
            ("a.md".to_string(), "---\ntype: meeting\ndate: 2026-08-01\n---\n\nA".to_string()),
            ("b.md".to_string(), "---\ntype: todo\n---\n\nB".to_string()),
            ("c.md".to_string(), "---\ntype: meeting\ndate: 2026-08-15\n---\n\nC".to_string()),
        ];
        let meetings = scan_meetings(&files);
        assert_eq!(meetings.len(), 2);
        assert_eq!(meetings[0].date, "2026-08-01");
        assert_eq!(meetings[1].date, "2026-08-15");
    }

    // A meeting note living inside a project's folder (#111/ADR-003) is discovered the same as
    // any other meeting note — the project note itself (type: project) is correctly excluded.
    #[test]
    fn scan_meetings_finds_a_meeting_note_inside_a_projects_folder() {
        let files = vec![
            ("todowai/backlog/parisjug/index.md".to_string(), "---\ntype: project\n---\n\nEvent.".to_string()),
            (
                "todowai/backlog/parisjug/kickoff.md".to_string(),
                "---\ntype: meeting\ndate: 2026-08-10\n---\n\nKickoff notes.".to_string(),
            ),
        ];
        let meetings = scan_meetings(&files);
        assert_eq!(meetings.len(), 1);
        assert_eq!(meetings[0].name, "Kickoff");
        assert_eq!(meetings[0].date, "2026-08-10");
    }
}
