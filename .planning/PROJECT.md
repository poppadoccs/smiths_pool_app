# Pool Field Forms

## What This Is

An iPad app for pool installation crews that replaces paper job forms with a digital workflow. Field workers select a job, take photos, fill out a form, and submit — which emails the completed form and photos to the office for review and forwarding. Built for Alex's friend who runs a pool installation business.

## Core Value

Workers can complete and submit job forms from the field without paper — photos, form data, and job info all land in the boss's office email in one submission.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Workers can create/select a job by name and/or job number
- [ ] Workers can take or attach photos to a job
- [ ] Workers can fill out a digital form for each job (one form per job)
- [ ] AI can generate a form template from a photo of a paper form
- [ ] Submitting a job emails the form + photos to a configured office email
- [ ] App works well on iPad in the field

### Out of Scope

- Office dashboard — email is sufficient for office-side review
- In-app approval/rejection workflow — office staff handle this via email
- Multiple forms per job — one form per job for now
- Worker accounts/login — keep it simple for v1
- Offline mode — can add later if field connectivity is an issue

## Context

- Target user: pool installation crews (field workers filling out forms, office staff reviewing)
- The paper form hasn't been provided yet — AI form generation from a photo is the workaround
- Workers take lots of job site photos that need to go with the form
- Office ladies verify the form, fix errors if needed, then forward via email
- This is being built as a favor for a friend — needs to be practical and reliable
- iPad is the primary device for field use

## Constraints

- **Platform**: iPad-first (web app that works great on iPad Safari or PWA)
- **Simplicity**: Field workers aren't tech people — must be dead simple to use
- **Email delivery**: Must reliably send form + photos to a configured email address
- **AI**: Needs vision AI to convert a photo of a paper form into a digital template

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Email-based office workflow | Simpler than building an admin dashboard, office staff already use email | — Pending |
| AI form template generation | Don't have the actual paper form yet, AI can recreate it from a photo | — Pending |
| One form per job | Keeps the data model simple, matches current paper workflow | — Pending |
| Job ID supports name and/or number | Friend's company might use either or both — stay flexible | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-03-25 after initialization*
