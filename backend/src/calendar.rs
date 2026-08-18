use serde::{Deserialize, Serialize};

/// A configured feed — mirrors the frontend's `CalendarFeed` (app/src/screens.ts), read from
/// `<subfolder>/calendars.json` via the existing generic file API (see #22). Not the same type
/// as that file's on-disk shape by coincidence: they're kept structurally identical on purpose
/// so api.rs can deserialize the file straight into this.
#[derive(Debug, Clone, Deserialize)]
pub struct CalendarFeedConfig {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub source: String,
    pub summary: String,
    /// RFC3339, always UTC — see parse_ics_datetime for what's (deliberately) not resolved.
    pub start: String,
    pub end: Option<String>,
}

/// Bounds the response regardless of how many events a feed actually contains — a personal
/// calendar export can easily hold years of history/future recurrences, and this app only ever
/// needs enough to inform "what's coming up," not a full calendar view.
const MAX_EVENTS: usize = 50;

/// Fetches and parses every configured feed, merges and de-duplicates the results, and returns
/// only events at or after now — a feed that can't be reached or parsed contributes zero events
/// rather than failing the whole batch (see fetch_feed's error handling).
pub async fn fetch_upcoming_events(feeds: &[CalendarFeedConfig]) -> Vec<CalendarEvent> {
    let now = chrono::Utc::now().to_rfc3339();

    let mut all_events = Vec::new();
    for feed in feeds {
        match fetch_feed(&feed.url).await {
            Ok(body) => all_events.extend(parse_ics(&body, &feed.label)),
            Err(error) => {
                tracing::warn!(feed = %feed.label, %error, "failed to fetch or read calendar feed");
            }
        }
    }

    let mut events = dedupe_and_sort(all_events);
    // RFC3339 strings compare lexicographically in chronological order as long as every
    // timestamp uses the same fixed-width UTC representation, which parse_ics_datetime always
    // produces — no need to parse back into a DateTime just to compare.
    events.retain(|event| event.start.as_str() >= now.as_str());
    events.truncate(MAX_EVENTS);
    events
}

async fn fetch_feed(url: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client.get(url).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response.text().await.map_err(|error| error.to_string())
}

/// De-duplicates by (start, summary) — the same event appearing in two feeds (e.g. a shared
/// meeting on both a work and a personal calendar) collapses to one entry, per the AC
/// ("de-duplicated by time"). Keeps whichever source was encountered first.
fn dedupe_and_sort(mut events: Vec<CalendarEvent>) -> Vec<CalendarEvent> {
    events.sort_by(|a, b| a.start.cmp(&b.start));
    let mut seen = std::collections::HashSet::new();
    events.retain(|event| seen.insert((event.start.clone(), event.summary.clone())));
    events
}

struct IcsProperty {
    name: String,
    params: String,
    value: String,
}

fn parse_property(line: &str) -> Option<IcsProperty> {
    let colon_index = line.find(':')?;
    let (name_and_params, value) = line.split_at(colon_index);
    let value = &value[1..];
    let mut parts = name_and_params.splitn(2, ';');
    let name = parts.next()?.to_ascii_uppercase();
    let params = parts.next().unwrap_or("").to_string();
    Some(IcsProperty { name, params, value: value.to_string() })
}

/// RFC5545 line folding: a line starting with a single space or tab is a continuation of the
/// previous line, not a new property — long SUMMARY/DESCRIPTION values are routinely wrapped
/// this way by real calendar exports.
fn unfold_lines(content: &str) -> Vec<String> {
    let normalized = content.replace("\r\n", "\n");
    let mut lines: Vec<String> = Vec::new();
    for raw_line in normalized.split('\n') {
        if (raw_line.starts_with(' ') || raw_line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().expect("checked non-empty above").push_str(&raw_line[1..]);
        } else if !raw_line.is_empty() {
            lines.push(raw_line.to_string());
        }
    }
    lines
}

/// Handles the two DTSTART/DTEND shapes actually seen in practice: a UTC timestamp
/// (`20260820T090000Z`) or an all-day date (`;VALUE=DATE:20260820`, no time component).
/// Deliberately does not resolve a floating/TZID-relative local time (no trailing `Z`, no
/// VALUE=DATE) to a precise instant against a timezone database — treated as UTC on a
/// best-effort basis rather than dropped, since most personal calendar exports already use UTC
/// or all-day dates. Expanding recurring events (RRULE) is out of scope entirely; a recurring
/// event surfaces only its first/anchor occurrence.
fn parse_ics_datetime(value: &str, params: &str) -> Option<String> {
    if params.contains("VALUE=DATE") {
        let date = chrono::NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        let datetime = date.and_hms_opt(0, 0, 0)?;
        return Some(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(datetime, chrono::Utc).to_rfc3339());
    }
    let trimmed = value.trim_end_matches('Z');
    let naive = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y%m%dT%H%M%S").ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc).to_rfc3339())
}

fn unescape_ics_text(value: &str) -> String {
    value
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

/// Parses every `VEVENT` block, tagging each with `source`. An event missing a usable DTSTART
/// is skipped rather than surfaced with a nonsense date — better to under-report than to show a
/// wrong time.
fn parse_ics(content: &str, source: &str) -> Vec<CalendarEvent> {
    let lines = unfold_lines(content);
    let mut events = Vec::new();
    let mut in_event = false;
    let mut summary: Option<String> = None;
    let mut start: Option<String> = None;
    let mut end: Option<String> = None;

    for line in &lines {
        let Some(property) = parse_property(line) else {
            continue;
        };
        match property.name.as_str() {
            "BEGIN" if property.value == "VEVENT" => {
                in_event = true;
                summary = None;
                start = None;
                end = None;
            }
            "END" if property.value == "VEVENT" => {
                if in_event {
                    if let Some(start) = start.take() {
                        events.push(CalendarEvent {
                            source: source.to_string(),
                            summary: summary.take().unwrap_or_else(|| "(untitled event)".to_string()),
                            start,
                            end: end.take(),
                        });
                    }
                }
                in_event = false;
            }
            "SUMMARY" if in_event => summary = Some(unescape_ics_text(&property.value)),
            "DTSTART" if in_event => start = parse_ics_datetime(&property.value, &property.params),
            "DTEND" if in_event => end = parse_ics_datetime(&property.value, &property.params),
            _ => {}
        }
    }

    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_single_utc_event() {
        let ics = "BEGIN:VCALENDAR\r\n\
                    BEGIN:VEVENT\r\n\
                    SUMMARY:Team standup\r\n\
                    DTSTART:20260820T090000Z\r\n\
                    DTEND:20260820T093000Z\r\n\
                    END:VEVENT\r\n\
                    END:VCALENDAR\r\n";
        let events = parse_ics(ics, "Work");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source, "Work");
        assert_eq!(events[0].summary, "Team standup");
        assert_eq!(events[0].start, "2026-08-20T09:00:00+00:00");
        assert_eq!(events[0].end.as_deref(), Some("2026-08-20T09:30:00+00:00"));
    }

    #[test]
    fn parses_an_all_day_event() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Company holiday\r\nDTSTART;VALUE=DATE:20260901\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics, "Work");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].start, "2026-09-01T00:00:00+00:00");
        assert!(events[0].end.is_none());
    }

    #[test]
    fn unfolds_a_wrapped_summary_line() {
        // Per RFC5545, the fold point itself contributes nothing — the space between "got" and
        // "wrapped" must already be part of the content before the CRLF, since the single
        // leading whitespace on the continuation line is the fold indicator, not literal text.
        let ics = "BEGIN:VEVENT\r\nSUMMARY:A very long meeting title that got \r\n wrapped across two lines\r\nDTSTART:20260820T090000Z\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics, "Work");
        assert_eq!(events[0].summary, "A very long meeting title that got wrapped across two lines");
    }

    #[test]
    fn parses_multiple_events() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:First\r\nDTSTART:20260820T090000Z\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nSUMMARY:Second\r\nDTSTART:20260821T100000Z\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics, "Personal");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "First");
        assert_eq!(events[1].summary, "Second");
    }

    #[test]
    fn skips_an_event_with_no_dtstart_rather_than_crashing() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:No start time\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nSUMMARY:Has a start\r\nDTSTART:20260820T090000Z\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics, "Work");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "Has a start");
    }

    #[test]
    fn missing_summary_falls_back_to_a_placeholder() {
        let ics = "BEGIN:VEVENT\r\nDTSTART:20260820T090000Z\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics, "Work");
        assert_eq!(events[0].summary, "(untitled event)");
    }

    #[test]
    fn unescapes_ics_text_sequences() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Coffee\\, then standup\\; then lunch\r\nDTSTART:20260820T090000Z\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics, "Work");
        assert_eq!(events[0].summary, "Coffee, then standup; then lunch");
    }

    #[test]
    fn dedupe_and_sort_collapses_the_same_event_from_two_feeds() {
        let events = vec![
            CalendarEvent {
                source: "Work".to_string(),
                summary: "Shared meeting".to_string(),
                start: "2026-08-21T10:00:00+00:00".to_string(),
                end: None,
            },
            CalendarEvent {
                source: "Personal".to_string(),
                summary: "Shared meeting".to_string(),
                start: "2026-08-21T10:00:00+00:00".to_string(),
                end: None,
            },
            CalendarEvent {
                source: "Work".to_string(),
                summary: "Earlier event".to_string(),
                start: "2026-08-20T09:00:00+00:00".to_string(),
                end: None,
            },
        ];

        let result = dedupe_and_sort(events);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].summary, "Earlier event");
        assert_eq!(result[1].summary, "Shared meeting");
        assert_eq!(result[1].source, "Work");
    }
}
