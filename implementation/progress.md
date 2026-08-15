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

<!--
Status values: In Progress | In Review | Merged | Superseded
Agent values: Claude (agent:claude) | Copilot (agent:copilot)

#9-#12 were built against the browser-only architecture superseded in specification/decisions.md
(ADR-001). The Phase 3 replan is complete (see plan/implementation.md and plan/deployment.md);
Phase 4 has resumed around the Rust core + self-hosted backend, starting with #59.
-->
