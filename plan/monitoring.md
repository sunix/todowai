# Monitoring Plan

Todowai's privacy-first positioning constrains monitoring: telemetry is opt-in, and note/conversation content must never be collected. Monitoring focuses on client health (crashes, sync, calendar fetch) and product-quality signals (AI suggestion confirm/reject rates), never on content.

## Key Metrics

- **Technical:** crash/error rate by platform+version, git sync pull/push success rate, merge-conflict frequency, calendar feed fetch failure rate.
- **Product:** AI suggestion confirm-vs-reject rate (next action, horizon, capture classification) as a proxy for suggestion quality.

## Action Items

- **Define privacy-respecting, opt-in telemetry policy** (S) — https://github.com/sunix/todowai/issues/44
  Document what may and may not be collected: no note or conversation content, ever; telemetry is opt-in and clearly disclosed, consistent with the privacy-first NFR.
  - [ ] Written policy explicitly lists collected fields and confirms content is excluded
  - [ ] Telemetry defaults to off until the user opts in

- **Crash/error reporting across PWA, Tauri, and Capacitor** (M) — https://github.com/sunix/todowai/issues/45
  Integrate opt-in crash and error reporting consistently across all three build targets.
  - [ ] Crashes/errors are captured with stack traces but no note content
  - [ ] Reports are tagged with platform and app version

- **Git sync health metrics (pull/push success, conflict rate)** (M) — https://github.com/sunix/todowai/issues/46
  Track sync engine health: pull/push success and failure rates, and merge-conflict frequency, without logging file contents.
  - [ ] Sync failures and conflicts are counted per session without content payloads
  - [ ] Metrics are queryable by platform and app version

- **Calendar feed fetch failure tracking** (S) — https://github.com/sunix/todowai/issues/47
  Track failures fetching/parsing configured calendar feeds, without logging feed URLs or event content.
  - [ ] Fetch failures are counted per feed (by opaque ID, not raw URL) without event content
  - [ ] Repeated failures for the same feed are distinguishable from one-off blips

- **AI suggestion confirm/reject rate tracking** (M) — https://github.com/sunix/todowai/issues/48
  Track aggregate confirm vs. reject/dismiss rates for AI suggestions (next action, horizon reassignment, capture classification) as a product-quality signal, without logging suggestion content.
  - [ ] Confirm/reject counts are tracked per suggestion type without content
  - [ ] Data can distinguish suggestion types (next-action vs. horizon vs. capture)

- **Dashboard: sync health & crash rate by platform/version** (M) — https://github.com/sunix/todowai/issues/49
  Build a dashboard surfacing sync health and crash rate, broken down by platform and app version, to catch regressions after releases.
  - [ ] Dashboard shows trend lines per platform/version
  - [ ] A test regression (simulated crash spike) is visible on the dashboard within the expected latency

- **Alerting: crash-rate regression threshold per release** (S) — https://github.com/sunix/todowai/issues/50
  Define an alerting threshold that flags when a new release's crash rate exceeds a baseline, so it can be caught quickly after rollout.
  - [ ] Threshold and comparison baseline are documented
  - [ ] A simulated regression triggers the alert in staging

- **Structured logging conventions (no PII/content)** (S) — https://github.com/sunix/todowai/issues/51
  Define structured logging conventions shared across web/desktop/mobile that explicitly exclude note/conversation content and personal data.
  - [ ] Logging guideline document lists allowed fields and explicitly forbidden ones (note content, calendar URLs, PII)
  - [ ] A lint/check catches accidental logging of forbidden fields in code review

