# Roadmap: Pool Field Forms

## Overview

Six sequential phases following the strict architectural dependency chain: jobs are the data container, photos need HEIC handling before submission depends on them, a manual form template ships before AI generation so workers can validate the app first, AI form generation comes after real-world validation, email submission integrates all previous phases last, and a final field-hardening phase locks in production readiness. Every iPad-specific constraint (48px targets, 16px fonts, auto-save, HEIC) is established in Phase 1 — none are bolted on later.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation + Jobs** - Project setup, database, job creation/selection, and iPad UI constraints locked in from day one
- [ ] **Phase 2: Photo Capture** - Camera capture, HEIC conversion, client-side compression, Vercel Blob upload, and photo gallery per job
- [ ] **Phase 3: Form Renderer** - JSON-schema-driven form with auto-save, validation, and draft resume — manual template first
- [ ] **Phase 4: AI Form Generation** - Admin route for paper form photo upload, GPT-4o extraction, and human review before deployment
- [ ] **Phase 5: Email Submission** - Full submission pipeline: PDF generation, Resend delivery, SPF/DKIM configured, confirmation UI
- [ ] **Phase 6: Polish + Field Hardening** - Error specificity, loading states, production deployment, and verified outdoor field test

## Phase Details

### Phase 1: Foundation + Jobs
**Goal**: Workers can create and select jobs on an iPad-optimized app that will never need to be reworked for field conditions
**Depends on**: Nothing (first phase)
**Requirements**: JOBS-01, JOBS-02, JOBS-03, JOBS-04, IPAD-01, IPAD-02, IPAD-03, IPAD-04, IPAD-05
**Success Criteria** (what must be TRUE):
  1. Worker can create a new job with a name and/or job number and see it appear in the job list
  2. Worker can select an existing job from the list and see its status (draft or submitted)
  3. All tap targets on the app are visibly large enough for outdoor use with dirty hands (48px+)
  4. Form inputs do not trigger iOS Safari auto-zoom (16px+ font enforced)
  5. App is accessible by bookmarking a URL to the iPad home screen — no App Store, no login
**Plans:** 3 plans
Plans:
- [x] 01-01-PLAN.md — Scaffold Next.js 16, Prisma schema, iPad CSS tokens, layout, manifest
- [ ] 01-02-PLAN.md — Job list, create form, job detail page, server actions
- [ ] 01-03-PLAN.md — Vitest tests, seed data, iPad visual verification checkpoint
**UI hint**: yes

### Phase 2: Photo Capture
**Goal**: Workers can attach, view, and manage photos for a job with no format or size surprises downstream
**Depends on**: Phase 1
**Requirements**: PHOT-01, PHOT-02, PHOT-03, PHOT-04, PHOT-05, PHOT-06
**Success Criteria** (what must be TRUE):
  1. Worker can take a photo using the iPad camera from within the app and see it added to the job gallery
  2. Worker can attach an existing photo from the iPad photo library
  3. Worker can view a thumbnail grid of all photos for a job and tap to enlarge
  4. Worker can delete a photo before submission
  5. Photos are compressed and converted to JPEG before upload — no HEIC files reach the server
**Plans**: TBD
**UI hint**: yes

### Phase 3: Form Renderer
**Goal**: Workers can fill out, save, and resume a digital form that behaves reliably on iPad Safari
**Depends on**: Phase 2
**Requirements**: FORM-01, FORM-02, FORM-03, FORM-04, FORM-05
**Success Criteria** (what must be TRUE):
  1. Worker can fill out a form with text fields, checkboxes, dropdowns, and number inputs
  2. Required fields are highlighted when empty and submission is blocked until they are filled
  3. Form data is automatically saved — if the worker closes the app and returns, their progress is restored
  4. Worker sees a visual "saved" indicator confirming draft persistence
**Plans**: TBD
**UI hint**: yes

### Phase 4: AI Form Generation
**Goal**: An admin can photograph a paper form and generate a working digital template that a human reviews before going live
**Depends on**: Phase 3
**Requirements**: AITL-01, AITL-02, AITL-03, AITL-04
**Success Criteria** (what must be TRUE):
  1. Admin can upload a photo of a paper form via a dedicated admin route
  2. AI extracts field names, types, and layout and presents them as a structured template
  3. Generated template can be reviewed and edited field-by-field before it is saved as the active template
  4. Saved template immediately drives the form renderer — workers filling forms use the updated template
**Plans**: TBD
**UI hint**: yes

### Phase 5: Email Submission
**Goal**: Workers can submit a job and the complete form + photos reliably land in the office inbox — not spam
**Depends on**: Phase 4
**Requirements**: SUBM-01, SUBM-02, SUBM-03, SUBM-04, SUBM-05
**Success Criteria** (what must be TRUE):
  1. Worker taps submit and receives a clear success screen confirming the email was sent
  2. Office receives an email with form data as a PDF attachment and photos as attachments or links
  3. Submission email lands in the inbox (not spam) — SPF, DKIM, and DMARC are configured on the sending domain
  4. Worker sees a specific error message if submission fails (not a generic "something went wrong")
  5. Submitting twice does not send duplicate emails — submit button is disabled after first tap
**Plans**: TBD

### Phase 6: Polish + Field Hardening
**Goal**: The app survives real field conditions — outdoor sunlight, wet hands, cellular data, 15+ photos in one session
**Depends on**: Phase 5
**Requirements**: (no new v1 requirements — this phase hardens the full delivered system)
**Success Criteria** (what must be TRUE):
  1. App is deployed to production on Vercel and accessible at a stable URL
  2. Submitting with too many large photos shows a specific warning before the attempt, not an error after
  3. Loading states are visible throughout (photo upload progress, submission in progress) — worker never wonders if something is happening
  4. Outdoor field test on an actual iPad passes: sunlight readable, wet-hand usable, cellular submission completes
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation + Jobs | 0/3 | Planned | - |
| 2. Photo Capture | 0/TBD | Not started | - |
| 3. Form Renderer | 0/TBD | Not started | - |
| 4. AI Form Generation | 0/TBD | Not started | - |
| 5. Email Submission | 0/TBD | Not started | - |
| 6. Polish + Field Hardening | 0/TBD | Not started | - |
