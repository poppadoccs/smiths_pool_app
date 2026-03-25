# Requirements: Pool Field Forms

**Defined:** 2026-03-25
**Core Value:** Workers can complete and submit job forms from the field without paper — photos, form data, and job info all land in the boss's office email in one submission.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Jobs

- [ ] **JOBS-01**: Worker can create a new job with a name and/or job number
- [ ] **JOBS-02**: Worker can select an existing job from a list
- [ ] **JOBS-03**: Worker can see job history with submission status (draft/submitted)
- [ ] **JOBS-04**: Each job stores associated photos, form data, and metadata

### Photos

- [ ] **PHOT-01**: Worker can take photos using iPad camera within the app
- [ ] **PHOT-02**: Worker can attach existing photos from iPad photo library
- [ ] **PHOT-03**: Worker can view a photo gallery for each job (thumbnails, tap to enlarge)
- [ ] **PHOT-04**: Worker can delete a photo from a job before submission
- [ ] **PHOT-05**: Photos are compressed client-side before upload (iPad photos are 5-12MB)
- [ ] **PHOT-06**: HEIC photos are converted to JPEG for Windows compatibility

### Forms

- [ ] **FORM-01**: Worker can fill out a digital form for a job (text, checkboxes, dropdowns, numbers)
- [ ] **FORM-02**: Form template is defined via JSON schema (manually created for v1)
- [ ] **FORM-03**: Form has validation — required fields highlighted, submission blocked until valid
- [ ] **FORM-04**: Form auto-saves to local storage on every field change (iPad Safari has no beforeunload)
- [ ] **FORM-05**: Worker can resume a draft form where they left off

### AI Template

- [ ] **AITL-01**: User can upload a photo of a paper form
- [ ] **AITL-02**: AI (GPT-4o vision) extracts field names, types, and layout from the photo
- [ ] **AITL-03**: AI generates a JSON schema form template from the extracted fields
- [ ] **AITL-04**: Generated template can be reviewed and adjusted before use

### Submission

- [ ] **SUBM-01**: Worker hits submit and form + photos are emailed to configured office email
- [ ] **SUBM-02**: Email contains form data as a PDF attachment
- [ ] **SUBM-03**: Email includes photos as attachments (or links if too large)
- [ ] **SUBM-04**: Worker sees clear success/failure confirmation after submission
- [ ] **SUBM-05**: Email sender domain has SPF/DKIM/DMARC configured (prevents spam folder)

### iPad UX

- [ ] **IPAD-01**: Touch targets are 48px+ minimum for field use with dirty/gloved hands
- [ ] **IPAD-02**: Form input font is 16px+ (prevents iOS Safari auto-zoom)
- [ ] **IPAD-03**: UI works in both landscape and portrait orientation
- [ ] **IPAD-04**: High contrast design readable in outdoor sunlight
- [ ] **IPAD-05**: App is accessible as a plain web app (bookmark to home screen)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Enhanced Features

- **PHOT-07**: Photo categorization (Before/During/After) with labels
- **SUBM-06**: Branded PDF output with company logo and name
- **FORM-06**: Multiple form templates (different job types)
- **JOBS-05**: Search/filter jobs by date, name, or status

### Reliability

- **OFFL-01**: Offline mode with service worker caching
- **OFFL-02**: Background sync when connectivity returns
- **SUBM-07**: Retry failed submissions automatically

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Office admin dashboard | Email is the dashboard. Doubles project scope for a favor project. |
| Worker login/accounts | Adds auth complexity. Crews share iPads. Use a "submitted by" name field instead. |
| Approval/rejection workflow | Office handles this via email replies and phone calls already. |
| Real-time GPS tracking | Privacy concerns. Job address is already in the data. |
| Scheduling/dispatch | Turns app into a full FSM platform. Boss assigns via phone/text. |
| Payment processing | Pool installations are invoiced separately, not paid at completion. |
| Complex conditional form logic | Flat forms with all fields visible. Skip what doesn't apply. |
| Multiple form templates (v1) | One form template. Add more later if needed. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| JOBS-01 | Pending | Pending |
| JOBS-02 | Pending | Pending |
| JOBS-03 | Pending | Pending |
| JOBS-04 | Pending | Pending |
| PHOT-01 | Pending | Pending |
| PHOT-02 | Pending | Pending |
| PHOT-03 | Pending | Pending |
| PHOT-04 | Pending | Pending |
| PHOT-05 | Pending | Pending |
| PHOT-06 | Pending | Pending |
| FORM-01 | Pending | Pending |
| FORM-02 | Pending | Pending |
| FORM-03 | Pending | Pending |
| FORM-04 | Pending | Pending |
| FORM-05 | Pending | Pending |
| AITL-01 | Pending | Pending |
| AITL-02 | Pending | Pending |
| AITL-03 | Pending | Pending |
| AITL-04 | Pending | Pending |
| SUBM-01 | Pending | Pending |
| SUBM-02 | Pending | Pending |
| SUBM-03 | Pending | Pending |
| SUBM-04 | Pending | Pending |
| SUBM-05 | Pending | Pending |
| IPAD-01 | Pending | Pending |
| IPAD-02 | Pending | Pending |
| IPAD-03 | Pending | Pending |
| IPAD-04 | Pending | Pending |
| IPAD-05 | Pending | Pending |

**Coverage:**
- v1 requirements: 29 total
- Mapped to phases: 0
- Unmapped: 29 ⚠️

---
*Requirements defined: 2026-03-25*
*Last updated: 2026-03-25 after initial definition*
