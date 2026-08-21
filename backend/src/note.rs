use std::collections::HashMap;

/// A minimal YAML-frontmatter subset reader — just scalar `key: value` lines plus the body, not a
/// general-purpose parser (mirrors the frontend's app/src/frontmatter.ts, #18). Shared by
/// projects.rs and horizon.rs, which both scan the same generic `key: value` shape; kept separate
/// from ai.rs's own parse_status, which is scoped to a different, specific shape (status.md's
/// `kind` field) and isn't a drop-in replacement for this one.
pub fn parse_frontmatter_fields(raw: &str) -> (HashMap<String, String>, String) {
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

/// The folder-note marker (ADR-003, #111): a folder containing this file *is* one note — any
/// other note type (project, task, meeting) can be promoted from a flat `<name>.md` to
/// `<name>/index.md` the moment it needs to hold more than itself (images, other notes). A
/// folder with no `index.md` isn't a note at all, which is what keeps the shared
/// `backlog`/`doing`/`done` folders from ever being mistaken for one — nobody puts an
/// `index.md` there.
pub const INDEX_FILE_NAME: &str = "index.md";

/// Notes don't carry an explicit title field today — derives a readable name from the filename
/// instead: strips a leading `YYYY-MM-DD-` date prefix (the project's own convention for filed
/// notes, see #16/#17) and the `.md` extension, then title-cases the remaining dash-separated
/// slug (e.g. "2026-08-10-client-x-migration.md" -> "Client X Migration"). For an `index.md`
/// (#111), the file itself has no meaningful name — the folder it lives in *is* the note — so
/// the title comes from the folder's own name instead of the literal "index".
pub fn display_name(path: &str) -> String {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    if file_name.eq_ignore_ascii_case(INDEX_FILE_NAME) {
        let folder_name = parent_dir_name(path).unwrap_or("Index");
        return title_case_slug(strip_date_prefix(folder_name));
    }

    let without_ext = file_name.strip_suffix(".md").unwrap_or(file_name);
    title_case_slug(strip_date_prefix(without_ext))
}

/// The name of the folder directly containing `path` — e.g. "parisjug" for
/// "todowai/backlog/parisjug/index.md". `None` when `path` has no containing folder at all.
fn parent_dir_name(path: &str) -> Option<&str> {
    let (parent, _) = path.rsplit_once('/')?;
    parent.rsplit('/').next()
}

fn title_case_slug(slug: &str) -> String {
    slug.split('-')
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
    fn display_name_strips_date_prefix_and_title_cases() {
        assert_eq!(display_name("todowai/backlog/2026-08-10-client-x-migration.md"), "Client X Migration");
        assert_eq!(display_name("karasun-side-project.md"), "Karasun Side Project");
    }

    #[test]
    fn display_name_without_a_date_prefix_is_unaffected() {
        assert_eq!(display_name("todowai/backlog/spec-cleanup.md"), "Spec Cleanup");
    }

    #[test]
    fn display_name_of_an_index_note_uses_the_folder_name_not_the_literal_index() {
        assert_eq!(display_name("todowai/backlog/parisjug/index.md"), "Parisjug");
    }

    #[test]
    fn display_name_of_an_index_note_strips_the_folders_own_date_prefix() {
        assert_eq!(display_name("todowai/backlog/2026-08-10-client-x-migration/index.md"), "Client X Migration");
    }

    #[test]
    fn display_name_of_index_is_case_insensitive() {
        assert_eq!(display_name("todowai/backlog/parisjug/INDEX.MD"), "Parisjug");
    }

    #[test]
    fn parse_frontmatter_fields_reads_scalar_fields_and_the_body() {
        let (fields, body) = parse_frontmatter_fields("---\ntype: todo\nstatus: backlog\n---\n\nBody text.");
        assert_eq!(fields.get("type").map(String::as_str), Some("todo"));
        assert_eq!(fields.get("status").map(String::as_str), Some("backlog"));
        assert_eq!(body, "Body text.");
    }

    #[test]
    fn parse_frontmatter_fields_with_no_frontmatter_returns_the_whole_content_as_body() {
        let (fields, body) = parse_frontmatter_fields("Just a plain note, no frontmatter.");
        assert!(fields.is_empty());
        assert_eq!(body, "Just a plain note, no frontmatter.");
    }
}
