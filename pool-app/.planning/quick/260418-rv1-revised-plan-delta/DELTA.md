---
id: 260418-rv1
title: Revised authoritative plan delta — customer feedback 2026-04-18
date: 2026-04-18
status: proposed (awaiting approval)
supersedes: [260417-mpf] (mpf is frozen at Task 2; reboot under rv1 for everything after)
---

# Revised Authoritative Plan Delta — rv1

Plan delta, not a full plan. Reads alongside mpf; only the parts that change are here.

---

## 0. Scope framing

Customer redefined the scope on 2026-04-18 after reviewing her current workflow. Three forces converge:

1. **Reliability** — Jimmy lost photos on mixed devices. Silent data loss. Blocks everything else.
2. **Workflow** — she's still pruning photos and forwarding manually because the edit/resend loop isn't shipped.
3. **Caps** — she gave exact per-target caps, not shared caps.

mpf's single-cap-per-field and formData-JSON-map model is NOT sufficient. Rebooting the data model.

---

## A. Photo state / ownership model

### Decision: extend `job.photos` metadata; no migration

Photos become the source of truth for their own state. FormData stops owning photo ownership.

**New PhotoMetadata shape** (stored in `job.photos: Json` — no schema migration):

```ts
type PhotoOwner =
  | { type: "unassigned" }
  | { type: "field";      fieldId: string; slot: number }        // Q5/16/25/40/71 + any future single-slot photo field
  | { type: "remarks";    fieldId: string; slot: number }        // Q15/33/72/76/79/83/91/102 notes photos
  | { type: "summary";    slot: number }                         // Q107 summary (flat slot 0..19)
  | { type: "additional"; slot: number };                        // Q108

type PhotoMetadata = {
  id: string;                    // NEW — stable UUID; primary identity (URL can recur on re-upload)
  url: string;                   // blob URL
  filename: string;
  size: number;
  uploadedAt: string;            // ISO
  owner: PhotoOwner;             // NEW — explicit owner state; defaults to {type:"unassigned"}
  includedInPdf: boolean;        // NEW — defaults true; excluded photos stay in editable view
};
```

**One-photo-one-owner retained** for v1. `PhotoOwner` is a tagged union; a photo is in exactly one bucket at any time.

**Why extend instead of introducing a Photo table:**
- `job.photos` is already `Json?`. Additive shape change, no `prisma db push` needed.
- Single-document atomicity: assigning a photo is one `updateMany` on Job, so races can't desync owner and URL.
- Keeps the blast radius small. A real Photo table can come in Phase 2 if the shape proves stable.

**Why NOT `formData["__photoAssignmentsByField"]`:**
- Jimmy's missing photos likely happened because autosave clobbered the map. Task 2 fixed the clobber, but the model is still brittle: two places storing the same truth (formData map + photos array), and URL-as-identity lets a re-upload silently replace the wrong entry.
- Moving ownership into `photos` entries means every write goes through one server action, one atomic update, one identity (photo.id). No key-clobber class of bug possible.

---

## B. Exact per-target caps

```
Q5  = 3    Q16 = 3    Q25 = 2    Q40 = 3    Q71 = 4
Q107 summary = 20    Q108 additional = 5
Remarks photos (6 each): Q15, Q33, Q72, Q76, Q79, Q83, Q91, Q102
```

Theoretical max per job: 3+3+2+3+4+20+5+(6×8) = **88 photos**.

### Enforcement points

| Target | UI (disable input at cap) | Server action (reject if would exceed) | PDF render |
|---|---|---|---|
| Q5/16/25/40/71 | MultiPhotoFieldInput slot grid | `setPhotoOwner` — check field count before accept | no cap check |
| Q15/33/72/76/79/83/91/102 | RemarksPhotoInput (new) | `setPhotoOwner` — check remarks field count before accept | no cap check |
| Q107 summary | SummaryPhotoInput | `setPhotoOwner` — check summary total before accept | no cap check |
| Q108 | AdditionalPhotoInput | `setPhotoOwner` — check additional total before accept | no cap check |

Only one cap-enforcement entry point: the server action `setPhotoOwner(photoId, newOwner)`. It reads current `job.photos`, counts the target bucket, rejects if the new placement would exceed the cap. UI disabling is a UX nicety; the server is the authority.

Caps exported from `src/lib/photo-caps.ts` (new):

```ts
export const PHOTO_CAPS = {
  field: {
    "5_picture_of_pool_and_spa_if_applicable": 3,
    "16_photo_of_pool_pump": 3,
    "25_picture_of_cartridge": 2,
    "40_picture_if_leak_is_present_at_chlorinator": 3,
    "71_picture_of_leaks_on_valves_if_applicable": 4,
  },
  remarks: {
    "15_remarks": 6,
    "33_remarks": 6,
    "72_remarks": 6,
    "76_remarks": 6,
    "79_remarks": 6,
    "83_remarks": 6,
    "91_remarks": 6,
    "102_remarks": 6,
  },
  summary: 20,
  additional: 5,
} as const;
```

(Exact remarks field ids TBD — need to grep `scripts/extraction-output.json` for the remarks field keys during Phase A. Placeholder above.)

---

## C. Q107 / Q108 / excluded semantics

**Q107 Summary.** Structured items in `formData.__summary_items = { text, photos: string[] (photo ids) }[]`. Photos referenced by stable id, not URL. Total across all items capped at 20.

**Q108 Additional.** Photos the office deems worth shipping that don't belong to a specific question. Up to 5. Ownership is explicit (`{type:"additional", slot}`), not derived.

**Unassigned = excluded from PDF by default.** Recommended safest office workflow:

1. Jimmy uploads a photo → photo lands with `owner.type = "unassigned"`, `includedInPdf = true`.
2. Office reopens draft, sees all photos listed in the admin assignment view.
3. Office assigns each photo to a bucket OR marks it `includedInPdf = false` (the exclude-from-report toggle).
4. At PDF render: only photos with `owner.type !== "unassigned" AND includedInPdf === true` appear.
5. At submit: if there are unassigned photos, show warning ("3 photos are not assigned to any question. They will not appear in the PDF but will remain in the editable version. Submit anyway?"). Warn, don't block.

### Why unassigned-excluded-by-default

- Customer quote: "Jimmy likes to take extra photos in case... I do not end up using a portion." The workflow is Jimmy-overshoots-office-curates. Default to exclude means accidentally-shipped photos become impossible; the office has to opt a photo in.
- "Do not assume all leftovers go to Q108 anymore" — explicit customer directive against the current auto-drain behavior.
- Safer default: mistake = missing photo (recoverable, office notices, resends). Opposite default: mistake = wrong photo sent to end client (unrecoverable reputation damage).

---

## D. Editable version after submit

### Options compared

| Option | Mechanism | Tradeoffs |
|---|---|---|
| **Edit link (recommended)** | Signed URL in email → opens admin reopen-draft view | Single source of truth (DB). Secure (signed, expiring). Handles photos natively. Same surface as resend. Requires she has internet + browser. |
| Structured HTML email body | Form inputs rendered in the email body | Email clients sanitize JS and don't round-trip photo uploads. Not viable for photo curation. |
| JSON/export attachment | `.json` file she downloads, edits, re-uploads | Hostile UX. No one hand-edits JSON. Reupload flow duplicates the edit-link mechanism anyway. |
| Word/HTML document attachment | `.docx` she edits in Word, re-attaches to email | Creates a fork in state. Photos don't round-trip. Her edits don't affect DB. Manual reconciliation required on her side. |

### Recommendation: signed edit link

Submit email contains:
1. **PDF attachment** — final, immutable artifact for end-client forwarding.
2. **"Edit this report" button** — signed URL like `https://app/jobs/{id}/edit?token={signed-jwt-or-hmac}`, expiring in 30 days.

Clicking the link:
- Validates the token.
- Opens `/admin/jobs/{id}/edit` (reuse existing reopen-draft view).
- She can reassign/exclude photos, edit text, edit summary items.
- Clicking **"Regenerate & Resend"** triggers submit again → new PDF + new email + new signed link.

Photos excluded from the PDF stay on the photos array with `includedInPdf = false`. They're visible in the admin view so she can re-include or reassign them. They never appear in any PDF rendered from that job, but they DO persist in the database.

**Token mechanism:** HMAC of `{jobId, issuedAt}` signed with a server secret. No session/cookie needed. Cheap, stateless, revocable by rotating the secret (global revoke only — acceptable for v1).

---

## E. Reliability / no-silent-loss plan

Jimmy's root cause is unknown but high-likelihood candidates:
- Client-side autosave overwrote `job.photos` with a stale client copy (the whole array replaced).
- Photo upload succeeded to blob but the metadata entry never made it to DB (no atomic coupling).
- `__photoAssignmentsByField` map was clobbered (Task 2 already addresses this class).
- Mobile Safari memory pressure killed a background upload; the client thought it succeeded.

The new model closes most of these by construction. Remaining reliability work:

### E1 — Immediate-write upload contract

```
Client: POST /api/photos/upload (multipart)
Server:
  1. Receive file.
  2. Write to Vercel Blob → get url.
  3. Write PhotoMetadata entry to job.photos (atomic job.update on photos array).
  4. Return { photoId, url }.
Client:
  5. Only treats the upload as successful after receiving the response.
  6. UI shows the photo card only when the response lands.
```

No client-side in-memory queue of "pending uploads" that could be lost on a refresh. Every photo exists in the DB the moment the UI shows it.

### E2 — Client never writes the photos array

All mutations to `job.photos` go through dedicated server actions: `uploadPhoto`, `setPhotoOwner`, `setPhotoIncluded`, `deletePhoto`. The client never sends the whole array back. `saveFormData` (Task 2) already doesn't touch `job.photos`, but this must be enforced — add a test that asserts `job.photos` is unchanged after a `saveFormData` call.

### E3 — Pre-submit reconciliation

Server action `validateJobForSubmit(jobId)` runs before submit:
1. Count photos by owner bucket; assert none exceeds its cap.
2. For each `includedInPdf && owner !== unassigned` photo, HEAD-fetch its blob URL; abort with list if any 404.
3. If unassigned photos exist, return `{ warn: true, unassignedCount }` (warning, not block).

Fails fast, with specific diagnostics.

### E4 — Post-render reconciliation

After `generate-pdf.ts` runs, it returns `{ pdfBytes, renderedPhotoIds: string[] }`. `submit.ts` asserts `renderedPhotoIds` equals the set of `{ id | photo.owner !== unassigned && photo.includedInPdf }` from the DB. Mismatch → abort email, log diagnostic.

### E5 — Photo event audit log (optional v1, strong recommend)

Add `job.photoEvents: Json[]` (no migration — Json field). Every state change appends `{ photoId, event: "upload"|"assign"|"include"|"exclude"|"delete", at: ISO, previousOwner?, newOwner? }`. On submit, if reconciliation E3 or E4 fails, include the audit log in the error diagnostic. Makes Jimmy's "photos disappeared" reproducible.

---

## F. Pagination / no-bad-split rules

Implemented in `generate-pdf.ts` as a pre-measure + conditional `addPage`. Rules:

| Block | Rule |
|---|---|
| Question label + answer (text) | Never split. If label+first-line doesn't fit → break before. |
| Question label + single photo | Atomic block (label + photo measured together). |
| Question label + photo grid (multi) | Atomic. Already mpf T5 behavior, keep. |
| Remarks label + first photo row | Atomic. |
| Summary item (heading + first line + first photo row) | Atomic. |
| Section header + first content row | Header keeps with next row. |
| Signature block | Atomic; never mid-split. |
| Page footer (page N of M) | Always rendered. Doesn't affect measurement. |

Each renderer computes `blockHeight` before writing. If `currentY + blockHeight + bottomMargin > pageHeight`, call `doc.addPage()` first. `blockHeight` includes the label, the answer/photos, and a small bottom padding.

### Edge case: block taller than a page

A summary item with 6 photos in a 2x3 grid could exceed a full page. Rules:
- If the WHOLE block > pageHeight, split on photo-row boundaries (never mid-photo, never between label and first row).
- Continuation row shows `(continued)` prefix on the label.

---

## G. PDF cleanup

Specific changes in `generate-pdf.ts`:

1. **Remove** the name/date header block above Q1/Q2. Current site: TBD (grep `job.customer_name` or `customerName` near top of the fields loop).
2. **Remove** "Submitted by" from page 1. Current site: TBD.
3. **Add** "Submitted by: {tech_name}" to the signature page, above or beside the signature image.
4. **Audit** remaining sites for client name + date. Expected allowed occurrences: cover page (once), signature page (once). Anything else is a duplicate.

Grep targets for the audit pass:
```
rg -n "customer_name|customerName|submittedBy|submitted_by|\.date\b" src/lib/actions/generate-pdf.ts
```

Each hit either stays (cover/signature only) or is removed.

---

## H. Resend button

**Location:** Admin reopened-draft view (`/admin/jobs/{id}/edit`), top-right action bar. Same view the edit-link lands on.

**Allowed job states:** `SUBMITTED`, `DRAFT_REOPENED` (post-edit but pre-resubmit). Disabled in `DRAFT` (use regular submit).

**Mechanism:**
1. Click → confirmation modal ("Regenerate PDF and email {address}?").
2. On confirm: regenerate PDF (fresh render from current DB state) → send email with PDF + new signed edit link.
3. Job state transitions to `RESENT` (or stays `SUBMITTED` with a `lastResendAt` timestamp — TBD per DB schema exploration).
4. Toast: "Sent to {address}."

**Interaction with editable version:** Resend email uses the same template as initial submit. PDF + edit link. The link re-opens the same admin edit view, so iterations are allowed.

---

## I. What remains valid from Tasks 1–2

### Task 1 (commit e96d55a)

| Artifact | Status under rv1 |
|---|---|
| `MULTI_PHOTO_FIELD_IDS` (5 ids) | **VALID** — still the five multi-photo targets. |
| `MULTI_PHOTO_CAP = 4` | **REPLACE** — per-target caps table instead. Consider keeping a `MAX_FIELD_CAP = 4` as a defensive ceiling. |
| `RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField"` | **LEGACY** — no longer the source of truth. Keep the constant exported (deprecated) to avoid breaking any in-flight caller, but new code does not write to it. Remove after all reads are migrated. |
| `REVIEWED_FLAG = "__photoAssignmentsReviewed"` | **DEPRECATE** — "reviewed" becomes derivable from `photos.every(p => p.owner.type !== "unassigned")`. Keep the constant for one release to avoid breaking existing data, but stop writing new values. |
| `readFieldPhotoUrls` helper | **REWRITE** — walks `job.photos` filtered by owner (field+slot ordered), returns urls. Legacy fallback to formData mirror for reads of SUBMITTED jobs submitted pre-rv1. |
| `RESERVED_SUMMARY_KEY = "__summary_items"` | **VALID** — summary items still live in formData (text + photo-id list). |
| `SummaryItem` type | **MODIFY** — `photos: string[]` becomes `photos: string[]` of photo IDs (not URLs). |
| `SUMMARY_PHOTO_SOFT_LIMIT = 25` | **REPLACE** — single cap `SUMMARY_PHOTO_CAP = 20`. No soft/hard split. |
| `SUMMARY_PHOTO_HARD_LIMIT = 40` | **REMOVE** — superseded by single 20 cap. |
| `parseSummaryItems`, `countSummaryPhotos`, `collectSummaryPhotoUrls` | **VALID** (countSummaryPhotos), **REWRITE** (parseSummaryItems accepts photo-id list; collectSummaryPhotoUrls becomes collectSummaryPhotoIds). |
| `FormData = Record<string, unknown>` widening | **VALID** — widening is protective, still needed. |

### Task 2 (commit 0ea2f9e)

**ALL VALID.** `saveFormData` autosave-preserve hardening is still necessary:
- `__summary_items` still lives in formData under the new model.
- Any future reserved formData key (e.g. a signature-reviewed flag) still needs this protection.
- `__`-prefix strip is still the right defense-in-depth.
- Submitted-job guard + updateMany + count==0 throw is still correct.
- undefined filter is still correct.

Task 2 requires ZERO changes for rv1.

### Task 2b (proposed but not yet executed)

**Still valid and desirable.** Strengthens the test-proof quality codex flagged. Can be interleaved with rv1 Phase D (reliability proofs) rather than run standalone. No urgency.

### mpf Tasks 3–12

**FROZEN. Not executed. rv1 supersedes.** Some concepts carry forward (Pass 1a, 2x2 grid render, summary editor) but land under the new data model, not the old formData-map model.

---

## Recommended execution order

Ordered by risk × user-visible value × dependency.

### Phase A — Small wins (ship first, same day)

| # | Task | Files | Why first |
|---|---|---|---|
| A1 | **Pagination rules** (no-orphan-label, no-mid-photo-split, atomic summary block) | `src/lib/actions/generate-pdf.ts` | Customer-reported bug. 1 commit. Visible fix. No data model dependency. |
| A2 | **PDF metadata cleanup** (remove dupe name/date, move "Submitted by" to signature page) | `src/lib/actions/generate-pdf.ts` | 1 commit. Cosmetic but cited directly by customer. |

### Phase B — Photo state foundation (critical, before any feature)

| # | Task | Files | Why |
|---|---|---|---|
| B1 | **Extend PhotoMetadata shape** — add `id`, `owner`, `includedInPdf` to TS types. No code writes these yet. | `src/lib/photo-types.ts` (new), `src/lib/forms.ts` | Type scaffolding. |
| B2 | **Per-target caps constants** | `src/lib/photo-caps.ts` (new) | Shared by UI + server. |
| B3 | **New server actions**: `uploadPhoto`, `setPhotoOwner`, `setPhotoIncluded`, `deletePhoto`. Each reads job.photos fresh, mutates one entry, writes atomically via updateMany+status guard (same pattern as Task 2). | `src/lib/actions/photos.ts` (extend) | Central write path. All future writes go through these. |
| B4 | **Backfill script** — for each job, derive photo ownership from existing `formData[fieldId]` (where set) and `__photoAssignmentsByField` (where set); assign `includedInPdf = true` everywhere; generate stable ids. Idempotent. | `scripts/backfill-photo-state.ts` (new) | One-shot. Run once in dev, once in prod. |
| B5 | **PDF resolver rewrite** — read from `job.photos` (owner+included) instead of `formData` map. Legacy fallback: if `job.photos` entries lack `owner` field (pre-rv1 data), fall back to formData mirror reads. Deterministic. | `src/lib/actions/generate-pdf.ts` | Now PDF render sees the same truth the DB has. |
| B6 | **Admin UI rewrite** — photo assignment view reads from `job.photos`, writes through new actions. Include/exclude toggle per photo. | `src/components/photo-assignments.tsx`, new components as needed | Customer's exclude-from-report feature lives here. |
| B7 | **Pre-submit reconciliation** — `validateJobForSubmit` checks caps, blob URL liveness, unassigned warning. | `src/lib/actions/submit.ts` (extend) | Fails closed. |
| B8 | **Post-render reconciliation** — `generate-pdf` returns `{ pdfBytes, renderedPhotoIds }`; submit asserts parity. | `src/lib/actions/generate-pdf.ts`, `src/lib/actions/submit.ts` | Catches render-vs-intent drift. |

### Phase C — Features

| # | Task | Files | Why |
|---|---|---|---|
| C1 | **Per-target cap enforcement in UI** | MultiPhotoFieldInput, RemarksPhotoInput (new), SummaryPhotoInput (new), AdditionalPhotoInput (new) | UX + UI-side guards. |
| C2 | **Include/exclude toggle surface** in the admin photo view | `src/components/photo-assignments.tsx` | Customer feature. |
| C3 | **Remarks photos** (Q15/33/72/76/79/83/91/102) — per-remarks-field upload UI; render in PDF under each remarks block | Multiple | New field class. |
| C4 | **Summary items editor** (Q107 structured) — 20-cap hard limit | `src/components/summary-items-editor.tsx` | Structured summary. |
| C5 | **Edit link in submit email** — signed URL token, API route to validate | `src/lib/email.ts`, `src/lib/edit-links.ts` (new), `src/app/api/edit-links/validate/route.ts` (new) | Workflow unlock. |
| C6 | **Resend button** on reopen-draft view | `src/components/job-actions.tsx` or equivalent | Customer feature. |
| C7 | **Dual submit email** — PDF + edit link rendered in email body | `src/lib/email.ts` | Workflow. |

### Phase D — Reliability proofs

| # | Task | Files | Why |
|---|---|---|---|
| D1 | **Photo event audit log** (optional) — `job.photoEvents` Json append-only. Used for diagnostics on reconciliation failure. | `src/lib/actions/photos.ts` | Jimmy's-issue retro tool. |
| D2 | **Regression suite** — legacy byte-equivalence (SUBMITTED pre-rv1 jobs render unchanged), new-model proofs, one-owner invariant, exclude-stays-available invariant, reconciliation pass/fail cases | `src/__tests__/regression/rv1-*.test.ts` | Catches future regressions. |
| D3 | **Task 2b test hardening** — codex's review findings (stateful mock, TOCTOU test, console.warn spy, strict strip assertion) | `src/__tests__/actions/forms.test.ts` | Tightens Task 2 proof quality. Can run any time. |

---

## Biggest risks (ordered)

1. **Silent photo loss (Jimmy's issue) RECURRING.** If the new model has any race or any client-array-write path, it's broken. Mitigated by: B3 (server-only writers), B5 (resolver reads from photos not formData), B7+B8 (dual reconciliation). Regression: D2's reconciliation tests.
2. **Legacy data regression.** SUBMITTED pre-rv1 jobs must still render correctly. Mitigated by: B5's fallback path. Regression: D2's legacy byte-equivalence proof.
3. **Backfill incorrectness.** B4 could misassign an edge case (e.g. a photo referenced from formData but not in photos array). Mitigated by: backfill is idempotent, dry-run mode logs inferences before writing, only runs after explicit approval.
4. **Edit link security.** A leaked signed URL is an unauthenticated admin surface. Mitigated by: HMAC signing, 30-day expiry, rotatable secret. Future: link-specific revocation.
5. **Cap creep.** Customer could ask for per-job overrides. Mitigated by: constants in one file; override becomes a per-job JSON field later without schema change.
6. **Pagination edge cases.** Very long text answers, very tall photo grids. Mitigated by: F's continuation-row rule, visual QA on real jobs in Phase A.
7. **Reopen-draft / resend state machine.** Current app has a reopened-draft concept; rv1's resend must fit cleanly. Risk: unknown existing behavior. Mitigated by: explicit grep/trace of current status transitions during B6 / C6.

---

## Changed assumptions (from mpf)

| mpf assumption | rv1 replacement |
|---|---|
| Photo ownership lives in `formData["__photoAssignmentsByField"]` | Photo ownership lives in `job.photos[].owner` |
| URL is identity | UUID id is identity; URL is just a resolution target |
| Q108 = all leftovers, drained by resolver | Q108 is explicit; unassigned photos are excluded by default |
| Single shared cap `MULTI_PHOTO_CAP = 4` for all 5 multi fields | Per-target caps, not shared |
| Summary cap: 25 soft / 40 hard | Summary cap: 20 hard |
| mpf Tasks 3–12 are the path forward | mpf Tasks 3–12 are frozen; rv1 Phases B–D replace them |
| "Reviewed sentinel" is a state flag in formData | "Reviewed" is derivable from photos array; sentinel is deprecated |
| Summary photos referenced by URL | Summary photos referenced by photo id |
| Email sends only PDF | Email sends PDF + signed edit link |
| Photos always appear somewhere in the PDF (Q108 drains leftovers) | Photos only appear in PDF if explicitly owned + included |

---

## No-code deliverables summary

1. **Revised plan delta** — this document.
2. **Changed assumptions list** — section above.
3. **Which old tasks remain valid** — Task 1 (partial, with modifications), Task 2 (fully valid unchanged), Task 2b (valid, low urgency).
4. **New execution order** — Phases A → B → C → D above.
5. **Biggest risks** — ordered list above.

---

## Open questions for you before implementation

1. **Exact remarks field ids.** Need to grep `scripts/extraction-output.json` for the 8 remarks fields. Can do during Phase B1. Just flagging that caps table has placeholders.
2. **"Submitted by" source field.** What template field holds the technician name today? Needed for G3 to render on the signature page.
3. **Edit link expiry window.** Recommended 30 days; customer may want longer (she holds reports for insurance?) or shorter (security posture).
4. **Should resend create a new Job or version the existing Job?** New Job = clean audit trail, complicates admin view. Version = simpler, requires a version number / resend counter. Recommending version for v1; defer new-Job-per-send to v2.
5. **Token secret storage.** `EDIT_LINK_SECRET` env var on Vercel. Rotation policy TBD.
