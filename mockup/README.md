# Todowai — Phase 2 Mockup

Self-contained clickable prototype in [`index.html`](./index.html), derived from `specification/specs.md`. Open the file directly in a browser — no server or build step required.

Navigation is a single-page app driven by the left sidebar; each screen below is a `<section id="view-*">` toggled via `data-view` on the corresponding sidebar button (no server-side routing/anchors).

| Screen | Element ID | Status | Notes |
|---|---|---|---|
| Capture | `#view-capture` | Draft | Quick-add note form + device tags (desktop/mobile/browser) + recently-captured list. Adding a note updates the list live. |
| Notebook | `#view-notebook` | Draft | Obsidian-style file tree (`todowai/done`, `doing`, `backlog`, `.ai`) + markdown preview pane. Click a file to load it. Repo/subfolder shown in the subtitle to reflect the configurable-repo decision. |
| Next Action | `#view-next-action` | Draft | Current-status card (cycles between task and situational statuses via "Change status"), AI suggestion card requiring explicit Confirm, "Today's plan" list, and a read-only "Upcoming" list representing the calendar feed. |
| Projects | `#view-projects` | Draft | Cards for large tasks / parallel work / AI-delegated work, with status badges and progress bars. Links back to Next Action to review AI suggestions. |
| Horizon | `#view-horizon` | Draft | Todos/projects grouped into This Week / This Month(s) / This Year columns. Each item has move buttons to reassign horizon manually; an AI suggestion banner proposes a reassignment that the user confirms or dismisses. |
| Meetings | `#view-meetings` | Draft | List of meeting notes; clicking one previews its Markdown + frontmatter (`type: meeting`, `date`, `attendees`). |
| Settings | `#view-settings` | Draft | Git repo path, subfolder, and a dynamic list of labeled calendar feed URLs (add/remove rows); encryption toggle shown disabled with a note that it's deferred to a later phase. |

**Also demonstrated (not a distinct screen):** a sync indicator in the sidebar footer with a "Simulate offline" checkbox, illustrating the offline-first / non-blocking-sync NFR (local changes persist and are labeled "will retry" while offline).

## Review checklist

- [ ] Screens match the six from `specification/specs.md`
- [ ] Next Action flow reflects "AI proposes, human confirms" from the acceptance criteria
- [ ] Situational-status suggestions (coffee break / commute → small backlog item) read naturally
- [ ] Horizon moves (manual + AI-suggested, confirm/dismiss) behave as expected
- [ ] Upcoming list merges events from multiple labeled calendar feeds
- [ ] Settings reflects: configurable repo + subfolder, multiple read-only calendar feeds, no encryption in v1

Next: review in a browser, then either ask the agent to iterate on this mockup, or run `sync-specs-from-mockup` if the review surfaces spec gaps, or tell the agent the mockup is approved to move to Phase 3.
