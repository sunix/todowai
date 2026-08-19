# Implementation Progress

> Tracks the build-out of the Phase 3 plan. Maintained by the `implement` skill,
> one row per GitHub issue. Phase 4 is complete when every planned issue is
> merged and the first version is deployed to QA/staging.

| Issue | Title | Agent | PR | Status |
|-------|-------|-------|----|--------|
| [#9](https://github.com/sunix/todowai/issues/9) | Scaffold PWA project shell | Claude | [#53](https://github.com/sunix/todowai/pull/53) | Merged |
| [#52](https://github.com/sunix/todowai/issues/52) | PWA PR preview via Surge (/preview comment) | Claude | [#54](https://github.com/sunix/todowai/pull/54) | Merged |
| [#10](https://github.com/sunix/todowai/issues/10) | Integrate isomorphic-git with File System Access API storage adapter | Copilot (+ Claude review/fixes) | [#56](https://github.com/sunix/todowai/pull/56) | Merged |
| [#11](https://github.com/sunix/todowai/issues/11) | Settings: configurable git repo path + subfolder | Claude | [#57](https://github.com/sunix/todowai/pull/57) | Merged |
| [#12](https://github.com/sunix/todowai/issues/12) | Offline-first sync engine (pull/push scheduling) | Claude | [#58](https://github.com/sunix/todowai/pull/58) (closed, not merged) | Superseded — see [ADR-001](../specification/decisions.md) |
| [#59](https://github.com/sunix/todowai/issues/59) | Scaffold Rust core + self-hosted backend service (git2-rs/gitoxide) | Claude | [#67](https://github.com/sunix/todowai/pull/67) | Merged |
| [#66](https://github.com/sunix/todowai/issues/66) | Per-PR backend preview image via GHCR (/preview comment) | Claude | [#68](https://github.com/sunix/todowai/pull/68), [#70](https://github.com/sunix/todowai/pull/70), [#71](https://github.com/sunix/todowai/pull/71), [#73](https://github.com/sunix/todowai/pull/73) | Merged |
| [#60](https://github.com/sunix/todowai/issues/60) | Backend: configurable repo subfolder + vault access rules | Claude | [#72](https://github.com/sunix/todowai/pull/72) | Merged |
| [#61](https://github.com/sunix/todowai/issues/61) | Web UI: integrate with the backend API | Claude | [#75](https://github.com/sunix/todowai/pull/75) | Merged |
| [#62](https://github.com/sunix/todowai/issues/62) | Rust core: git pull/push sync engine (offline-first) | Claude | [#76](https://github.com/sunix/todowai/pull/76) | Merged |
| [#77](https://github.com/sunix/todowai/issues/77) | Web UI: remote sync configuration + status indicator | Claude | [#78](https://github.com/sunix/todowai/pull/78) | Merged |
| [#13](https://github.com/sunix/todowai/issues/13) | Non-blocking git 3-way merge conflict handling | Claude | [#79](https://github.com/sunix/todowai/pull/79) | Merged |
| [#14](https://github.com/sunix/todowai/issues/14) | Notebook view: file tree + markdown viewer/editor | Claude | [#80](https://github.com/sunix/todowai/pull/80) | Merged |
| [#15](https://github.com/sunix/todowai/issues/15) | Capture view: quick-add note UI | Claude | [#81](https://github.com/sunix/todowai/pull/81) | Merged |
| [#16](https://github.com/sunix/todowai/issues/16) | Capture filing flow — manual path | Claude | [#82](https://github.com/sunix/todowai/pull/82) | Merged |
| [#17](https://github.com/sunix/todowai/issues/17) | Capture filing flow — AI-proposed path | Claude | [#83](https://github.com/sunix/todowai/pull/83) | Merged |
| [#18](https://github.com/sunix/todowai/issues/18) | Frontmatter conventions & parser for note types | Claude | [#84](https://github.com/sunix/todowai/pull/84) | Merged |
| [#19](https://github.com/sunix/todowai/issues/19) | Current-status field (task or situational context) | Claude | [#85](https://github.com/sunix/todowai/pull/85) | Merged |
| [#20](https://github.com/sunix/todowai/issues/20) | Next Action: AI next-todo suggestion engine | Claude | [#86](https://github.com/sunix/todowai/pull/86) | Merged |
| [#21](https://github.com/sunix/todowai/issues/21) | Situational-context small-suggestion behavior | Claude | [#88](https://github.com/sunix/todowai/pull/88) | Merged |
| [#89](https://github.com/sunix/todowai/issues/89) | Persist Remote sync and AI provider settings locally (ad hoc, not in the Phase 3 plan) | Claude | [#90](https://github.com/sunix/todowai/pull/90) | Merged |
| [#22](https://github.com/sunix/todowai/issues/22) | Settings: multiple labeled calendar feed URLs | Claude | [#91](https://github.com/sunix/todowai/pull/91) | Merged |
| [#23](https://github.com/sunix/todowai/issues/23) | ICS feed fetch + parse (read-only, multi-source) | Claude | [#92](https://github.com/sunix/todowai/pull/92) | Merged |
| [#24](https://github.com/sunix/todowai/issues/24) | Upcoming list in Next Action, labeled by source | Claude | [#93](https://github.com/sunix/todowai/pull/93) | Merged |
| [#25](https://github.com/sunix/todowai/issues/25) | Projects view: tracking large tasks & delegated work | Claude | [#94](https://github.com/sunix/todowai/pull/94) | Merged |
| [#95](https://github.com/sunix/todowai/issues/95) | Project notes: task checklists with auto-derived progress (ad hoc, not in the Phase 3 plan) | Claude | [#97](https://github.com/sunix/todowai/pull/97) | Merged |
| [#96](https://github.com/sunix/todowai/issues/96) | Capture: manual "attach to project" picker (ad hoc, not in the Phase 3 plan) | Claude | [#98](https://github.com/sunix/todowai/pull/98) (closed, not merged) | Superseded by [#99](https://github.com/sunix/todowai/issues/99) |
| [#99](https://github.com/sunix/todowai/issues/99) | Capture: AI-proposed attachment to an existing note (ad hoc, not in the Phase 3 plan) | Claude | [#100](https://github.com/sunix/todowai/pull/100) | Merged |
| [#101](https://github.com/sunix/todowai/issues/101) | Capture: AI-proposed multiple actions from a single capture (ad hoc, not in the Phase 3 plan) | Claude | [#102](https://github.com/sunix/todowai/pull/102) | Merged |
| [#26](https://github.com/sunix/todowai/issues/26) | Horizon view: week/month/year grouping with manual move | Claude | [#103](https://github.com/sunix/todowai/pull/103) | Merged |

<!--
Status values: In Progress | In Review | Merged | Superseded
Agent values: Claude (agent:claude) | Copilot (agent:copilot)

#9-#12 were built against the browser-only architecture superseded in specification/decisions.md
(ADR-001). The Phase 3 replan is complete (see plan/implementation.md and plan/deployment.md);
Phase 4 has resumed around the Rust core + self-hosted backend, starting with #59.
-->
