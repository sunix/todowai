# Project Specification

> This file is owned by the human. Use the `refine-specs` skill to iterate with the agent.
> Sections marked `[CONFIRMED]` have been reviewed and agreed upon.

---

## Project Summary

Todowai is a personal productivity application that helps a user decide what to do at any given moment. It should keep memory of what the user has done, is doing, and wants to do inside a large Obsidian-style Markdown notebook, let the user capture notes from mobile, browser, and desktop, and use AI to reorganize notes, help follow projects, support delegated AI work, and suggest what to do next across large tasks, parallel work, and meetings.

---

## Actors

| Actor | Role |
|-------|------|
| Individual user | Captures notes, tracks what they have done / are doing / want to do, and follows projects from multiple devices. |
| AI assistant | Reorganizes notes, helps follow projects, supports delegated work, and proposes what the user should do next. |

---

## Use Cases / User Stories

- **As an** individual user, **I want to** capture notes from mobile, browser, or desktop, **so that** I can record information from anywhere.
- **As an** individual user, **I want to** keep track of what I have done, what I am doing, and what I want to do, **so that** I have a personal history of my work and intentions.
- **As an** individual user, **I want the AI to** reorganize my notes, **so that** my note base stays cleaner and easier to use.
- **As an** individual user, **I want the AI to** suggest what I should do next, **so that** I can decide what to work on at each moment.
- **As an** individual user, **I want to** track large tasks, work happening in parallel, and meetings, **so that** I can follow ongoing commitments.
- **As an** individual user, **I want to** delegate some work to AI, **so that** the application can help me move projects forward.

---

## Screens / Views

- **Capture view:** a quick way to add or edit notes from mobile, browser, and desktop contexts.
- **Notebook view:** an Obsidian-style Markdown workspace containing what the user has done, is doing, and wants to do.
- **Next action view:** a view where the AI suggests what the user should do next.
- **Project tracking view:** a place to follow large tasks, parallel work, and delegated AI work.
- **Meetings view:** a place to keep track of meeting-related notes and commitments.

---

## Acceptance Criteria

- The product lets the user create and edit notes from mobile, browser, and desktop environments.
- The product keeps track of what the user has done, is doing, and wants to do in an Obsidian-style Markdown note base.
- The AI can reorganize notes to keep them cleaner.
- The AI can suggest what the user should do next.
- The product supports tracking large tasks, parallel work, and meetings.
- The product supports workflows where some work can be delegated to AI.
- The privacy model keeps notes as private as possible.

---

## Non-Functional Requirements

- Privacy is a primary requirement; notes should stay as private as possible.
- Notes should be stored in a private Git repository.
- AI conversations may be stored in a separate Git repository.
- Note encryption should be considered, potentially with GPG.
- The product should remain accessible and editable on mobile and PC in parallel.

---

## Out of Scope

TODO: explicitly list what this project will NOT do.

---

## Open Questions

- Should the product ship first as mobile, browser, desktop, or all three together?
- Should notes definitely live in a private Git repository, or is that only one implementation option?
- Should AI conversation history always be stored in a separate repository?
- What encryption approach should be used for notes, and should GPG be the default?
- How should concurrent edits between mobile and PC be synchronized and conflict-resolved?
- How should meetings be represented: simple notes, dedicated objects, or calendar-linked entries?
- What kinds of tasks can be delegated to AI in the first version?
