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

/// Notes don't carry an explicit title field today — derives a readable name from the filename
/// instead: strips a leading `YYYY-MM-DD-` date prefix (the project's own convention for filed
/// notes, see #16/#17) and the `.md` extension, then title-cases the remaining dash-separated
/// slug (e.g. "2026-08-10-client-x-migration.md" -> "Client X Migration").
pub fn display_name(path: &str) -> String {
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
    fn display_name_strips_date_prefix_and_title_cases() {
        assert_eq!(display_name("todowai/backlog/2026-08-10-client-x-migration.md"), "Client X Migration");
        assert_eq!(display_name("karasun-side-project.md"), "Karasun Side Project");
    }

    #[test]
    fn display_name_without_a_date_prefix_is_unaffected() {
        assert_eq!(display_name("todowai/backlog/spec-cleanup.md"), "Spec Cleanup");
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
