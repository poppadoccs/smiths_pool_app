---
id: 260418-rv3
title: Revised authoritative plan delta — photo state, per-target caps, reliability, editable version
date: 2026-04-18
status: planning
supersedes_tasks: mpf Tasks 3–12 (Task 1 + Task 2 remain shipped; constants partially deprecated — see §I)
base: 260417-mpf (shipped Tasks 1–2) + customer source of truth 2026-04-18
---

# Quick Task 260418-rv3 — Revised Plan Delta

Authoritative plan delta that replaces mpf Tasks 3–12. Task 1 (shared constants) and Task 2 (autosave-preserve) remain shipped and load-bearing; §I enumerates which exported symbols survive and which are superseded. Ground-truthed against the current codebase on 2026-04-18.

---

## A. Photo state / ownership model

**Model (v1, one-photo-one-owner):**

Every photo uploaded to a job has two orthogonal states:

1. **Editable owner** — one of the following, never more than one:
   - `fieldId` of a numbered photo question (Q5, Q16, Q25, Q40, Q71 — the five multi-photo fields)
   - `fieldId` of a remarks/notes field (Q15, Q33, Q72, Q76, Q79, Q83, Q91, Q102)
   - Synthetic summary-item identifier `__summary_item_<ordinal>` for Q107 structured items (ordinal = stable index into `__summary_items`)
   - `"108_additional_photos"` for Q108
   - `null` = unassigned (blocks submit by default; see §E)

2. **Report visibility** — one of:
   - `"included"` — photo appears in the PDF under its owner
   - `"excluded"` — photo does NOT appear in the PDF; still persisted in the DB; still delivered in the editable version (see §D)

**Where this lives:** a new reserved `__`-prefixed key inside `formData`, named `__photoStates`. Shape:

```
formData["__photoStates"] = {
  "<photoUrl>": { owner: string | null, include: boolean, setAt: <ISO timestamp> },
  ...
}
```

Identity is `photoUrl` (matches the existing `job.photos[].url` identity used across `generate-pdf.ts` and `photo-assignments.ts`).

**Why `formData.__photoStates` and not a Prisma column:**

- `Job.formData` is already `Json?` (`prisma/schema.prisma:51`) — no schema change, no migration, no Neon-on-Hobby migration risk (CLAUDE.md prohibits `prisma migrate` against the live Neon DB).
- The autosave-preserve hardening shipped in Task 2 (`src/lib/actions/forms.ts`) already strips `__`-prefixed keys from the client payload and re-reads DB state before every autosave write. `__photoStates` inherits this protection for free.
- Keeping photo state adjacent to form data means one DB read resolves both, simplifies the PDF pass ordering, and makes reconciliation trivial (§E).
- The alternative — a dedicated `PhotoState` table or extending `PhotoMetadata` — would require `prisma db push` migrations, is off-limits per CLAUDE.md, and buys nothing in exchange.

**Why one-photo-one-owner in v1:**

Matches the customer's mental model ("this photo is the cartridge photo"). Simpler ownership invariant for reconciliation. Covers every requirement in the 2026-04-18 source of truth. Multi-owner (a photo attached to both Q5 and Q107) is not requested and would break the no-silent-loss invariant in §E because a single reconciliation count no longer matches.

**Back-compat with existing shipped state:**

- `formData[fieldId] = url` (legacy single-slot photo fields) — still the mirrored primary for Q5/Q16/Q25/Q40/Q71 and for any other existing photo field. `__photoStates` is additive; a photo assigned to Q5 writes BOTH `formData["5_..."] = firstUrl` (existing mirror) AND `__photoStates[url] = { owner: "5_...", include: true }` (new state).
- `__photoAssignmentsByField` (shipped constant from Task 1) — still the authoritative multi-photo slot list for Q5/Q16/Q25/Q40/Q71. `__photoStates` does NOT replace it; it complements it by adding the include/exclude dimension and by covering photos that belong to remarks/notes/summary/Q108/unassigned (which `__photoAssignmentsByField` never covered).
- `__photoAssignmentsReviewed` — still the gate for the 3-pass legacy resolver in `generate-pdf.ts`. Once rv3 ships, this flag remains authoritative for legacy-shaped jobs; new-shape jobs will always have `__photoStates` populated and will never need the Pass 2 sequential fallback.

---

## B. Exact per-target caps

**Customer source of truth (2026-04-18, verbatim):**

| Target | Cap |
|---|---|
| Q5 picture of pool and spa if applicable | 3 |
| Q16 photo of pool pump | 3 |
| Q25 picture of cartridge | 2 |
| Q40 picture if leak is present at chlorinator | 3 |
| Q71 picture of leaks on valves if applicable | 4 |
| Q107 Summary (total across all items) | 20 |
| Q108 Additional Photos | 5 |
| Q15, Q33, Q72, Q76, Q79, Q83, Q91, Q102 (each remarks/notes field, individually) | 6 |

**Enforcement, per location:**

- **UI** (`src/components/multi-photo-field.tsx` — new component per-field, spawned by mpf Task 6 but cap-aware in rv3; `src/components/summary-items-editor.tsx`; new `src/components/remarks-photo-attachments.tsx`)
  - Per-field "+ Add photo" button disables when the field's current photo count reaches its cap.
  - Soft-warning chip appears one below cap (e.g. "2 of 3 — one more allowed") as a UX nudge. No soft vs. hard distinction otherwise (mpf's 25/40 split is deprecated — customer gave a single cap).
  - For Q107, the cap is across ALL summary items combined; the "+ Add photo" button inside any item disables when the global count hits 20.

- **Server action** (`src/lib/actions/photo-assignments.ts` — existing; extended)
  - A new helper `PHOTO_CAPS` (map: fieldId → cap) or per-owner-type function replaces the uniform `MULTI_PHOTO_CAP = 4`.
  - `assignMultiFieldPhotos(jobId, fieldId, urls)` rejects if `urls.length > PHOTO_CAPS[fieldId]`.
  - A new action `assignRemarksFieldPhotos(jobId, fieldId, urls)` enforces the 6-cap for remarks fields (same validation shape).
  - `saveSummaryItems(jobId, items)` (already spec'd in mpf Task 8, not yet shipped) enforces the single 20-total cap; mpf's `SUMMARY_PHOTO_HARD_LIMIT = 40` is superseded (see §I).
  - A new action `assignAdditionalPhotos(jobId, urls)` enforces Q108's 5-cap.
  - `setPhotoInclude(jobId, photoUrl, include)` — writes `__photoStates[url].include` without touching owner.

- **PDF render** (`src/lib/actions/generate-pdf.ts`)
  - Defense-in-depth only: if a field's resolved URL list somehow exceeds its cap (e.g. a stale DB write from before this task lands), PDF render truncates to the cap and logs a warning. Never crashes. Never renders over-cap.
  - This exists to catch the diagonal case where server-side cap enforcement is added but historical data violates it.

---

## C. Q107 / Q108 / excluded semantics

**Q107 Summary (up to 20 photos total):**

- Belongs: free-form per-item observations that the tech wants in the report under "107. Summary" with their photos inline. Typical use: "Observed algae in shallow end [photo]", "Chlorinator inlet loose [photo, photo]". The mpf structured `__summary_items` shape is retained unchanged.
- Ownership on a summary photo: `owner = "__summary_item_<ordinal>"` in `__photoStates`, where ordinal is its position in `__summary_items`.
- Cap: 20 total across all items (hard, single limit). Soft UI nudge at 19.

**Q108 Additional Photos (up to 5 photos):**

- Belongs: photos the tech wants in the report but that didn't fit any numbered question or summary item — the "put it somewhere visible" bucket. Capped at 5 to keep PDF size bounded.
- Ownership: `owner = "108_additional_photos"` in `__photoStates`.
- **No longer a drain.** The mpf/current-code behavior of "any leftover photo auto-drains into Q108 at render time" is REMOVED in rv3. See §E — auto-drain is a silent-loss vector because it lets photos go somewhere even when the tech never intended them to.

**Unused / extra photos — rv3 policy:**

- An uploaded photo that has no `__photoStates` entry, OR has `owner = null`, is **unassigned**.
- Unassigned photos are **not auto-placed anywhere**. They do not drain to Q108.
- At submit time: if any unassigned photos exist, submit is **blocked** with a clear error listing the orphan URLs and a link back to the photo-assignments UI. (Exception path: an explicit "exclude from report" action sets `include = false` with `owner = null` — then the photo is valid for submit and surfaces only in the editable version.)
- Rationale: Jimmy's mixed-device report (a photo that was "saved" but never appeared in docs) is exactly this class of bug. Making unassigned photos block submit converts silent loss into a loud, user-actionable error.

**Safest office workflow recommendation:**

1. Tech uploads all photos during the visit; each upload immediately persists a `PhotoMetadata` row via the existing `savePhotoMetadata` (`src/lib/actions/photos.ts`). This is already the shipped behavior (the uncommitted diff on `photos.ts` converts it to a raw SQL append that's atomic per-upload — preserve this).
2. Immediately after each photo upload, the UI opens a micro-assignment step: "Which question is this for? [Q5] [Q16] [Q25] [Q40] [Q71] [Q107 Summary] [Q108 Additional] [Remarks field…] [Exclude from report]". This writes `__photoStates[url]` on the same request. If the tech skips it, the photo is unassigned and surfaces in a "pending assignment" banner at the top of the form.
3. On submit, the reconciliation gate (§E) blocks if any photo is unassigned. The tech can resolve each one by assigning it or explicitly excluding it.

Why this is safest: every photo has an explicit decision tied to it before submit. No photo is auto-placed. No photo is silently dropped.

---

## D. Editable version after submit

**Options compared:**

| Option | What it actually is | Pro | Con |
|---|---|---|---|
| D1. Edit link back into app | Email contains a signed, tokenized URL (e.g. `/jobs/<id>/edit?t=<signed-token>`) that reopens the form in a post-submit edit mode. Token is HMAC-signed, scoped to jobId, expires in 30 days. | Real editing; one source of truth; excluded photos visible on page with include-toggle. | Requires a new route + token signing + a new "post-submit edit" form variant (not the same as DRAFT edit). Highest build cost. |
| D2. Structured HTML email body | Today's email body (`src/lib/email.ts`) is extended to render: all form fields as label/value, all photos with clear owner labels ("Q5 — included", "Q107 summary item 1 — included", "Excluded from PDF"), and all excluded photos inline as thumbnails + links. | Immediate readability for office. No login, no token. Includes excluded photos the PDF omits. | Not truly editable — the office has to email back or phone to request changes. |
| D3. JSON/export attachment | `.json` file attached to the email with full `formData` + photo manifest. | Machine-readable; can feed into another tool. | Office staff don't read JSON. Doesn't solve the readability problem. |
| D4. Separate editable artifact (Word / Google Doc link) | Render form to `.docx` or a Google Doc; attach / link. | Familiar editing UI for office. | Big new render path, new dep, formatting divergence from PDF. |

**Recommendation: D1 + D2 layered (both shipped).**

- **D2 first** (lower build cost, reachable in one task) — the HTML body becomes a genuine fallback "readable reference" that includes excluded photos and photos-with-labels. Solves the "where did Jimmy's missing photo go" visibility problem immediately.
- **D1 second** (bigger task; sequenced after D2) — adds real editing. The edit link opens a post-submit form variant that respects submitted-job-immunity (per §E and Task 2 autosave guard): edits go through the SAME autosave-preserve action but with a status exception gated by token validity. Resubmit from the edit view triggers a new PDF + new email via the resend path (§H).

**Tradeoffs:**

- D1 alone would be faster to ship but would fail the "email arrives with all the context" use case — office staff who don't click the link see only the PDF and have no way to know which photos were excluded.
- D2 alone would be cheaper but fails the literal "editable version" customer ask. Office can read, not edit.
- Layered (D1+D2) is the honest answer. D2 lands in a single small task; D1 lands in a follow-on task. The email body itself becomes the artifact the customer can reference until D1 ships — no "nothing works yet" window.

**Security on the edit link (D1):**

- Token format: `HMAC-SHA256(jobId + issuedAt + expiresAt, SIGNING_SECRET)`; base64-url-encoded. Signed with a new `JOB_EDIT_LINK_SECRET` env var.
- Expiry: 30 days from issue. A resend (§H) reissues a fresh token with a bumped expiry.
- Scope: single jobId; the route validates token → jobId match and expiry before allowing any action.
- Revocation: not required in v1 (expiry suffices); if needed later, a DB-side `editTokenRevokedAt` timestamp column can gate.

---

## E. Reliability / no-silent-loss plan

**Addresses:** Jimmy's mixed-device report — photos appearing to save to the intended question but not appearing in any generated doc.

**Root-cause analysis against the current code:**

- Photos are persisted to the DB on upload (`src/lib/actions/photos.ts::savePhotoMetadata` uses an atomic JSONB append via raw SQL). So the photo **record** is in DB immediately after upload.
- The **assignment** from photo to field (either `formData["5_..."]` for legacy single-slot, or `__photoAssignmentsByField["5_..."]` for multi-photo) depends on a separate server action call. If that action is never fired (e.g. the tech moves to a different device before autosave fires, or the assignment is made on device A but the session state on device B overrides it), the photo exists in `job.photos` but has no owner.
- At PDF generation (`src/lib/actions/generate-pdf.ts`), such an orphan photo currently drains into Q108 via Pass 3 (`photosQueue` at line 237). But if the Q108 cap becomes 5 and there are 6+ orphans, the extras silently drop off the end of the queue once Q108 finishes rendering.
- Alternatively, if an admin has marked the job "reviewed" (`__photoAssignmentsReviewed = true`) with empty assignments, the orphan photo falls through Pass 1 unresolved, the Pass 2 gate is closed, and Pass 3 drains it into Q108 — again silently, with no manifest of what went where.

**Prevention plan (stacked, each layer catches different failure modes):**

1. **Upload persistence is already synchronous and DB-first** (existing `savePhotoMetadata`). Keep the raw-SQL append pattern from the uncommitted `photos.ts` diff — it's atomic and survives partial client state. **Verify this in the rv3 test suite**: a photo upload followed by device switch must still show the photo in `job.photos` after reload.

2. **Every photo MUST have an explicit `__photoStates` entry before submit.** No implicit state, no auto-drain. Unassigned photos surface in a "pending assignments" banner at the top of the form.

3. **Pre-submit reconciliation gate** (new code path in `src/lib/actions/submit.ts`):
   - Enumerate `job.photos[].url` — the set of photos the DB believes exist.
   - Enumerate `Object.keys(formData["__photoStates"] ?? {})` — the set of photos with explicit state.
   - **Invariant: every DB photo URL must have a state entry.** If not, return `{ success: false, error: "N photos have no report assignment: <comma-separated URLs>. Resolve before submitting." }` and do NOT commit the status flip.
   - This error blocks submit. The UI surfaces it and links back to the assignments page.

4. **PDF render manifest** (new, written during `generateJobPdf`):
   - As each photo is rendered (or explicitly skipped for `include = false`), append to a local manifest array: `{ url, owner, action: "rendered" | "excluded" | "failed" }`.
   - After render, cross-check: manifest URLs === `job.photos[].url`. Mismatch = render bug (photo orphaned through a code path that bypassed the state map).
   - On mismatch, the returned result includes `{ success: false, error: "PDF render integrity failure: <N> photos accounted, <M> in DB", orphans: [...] }`. Submit does not send the email.

5. **Resend safety** (§H): every resend re-runs the same reconciliation gate and manifest check, so a submit that passed the gate when data was clean cannot silently drop photos on a later resend.

6. **Proof mechanism in the editable version (§D)**: the HTML email body explicitly labels each photo with its owner AND its include/exclude state. Excluded photos are shown as thumbnails in a "Not in PDF (excluded from report)" section. This is user-facing proof: if a tech expects Q5 to have 3 photos and the email shows 2, they see the gap immediately instead of noticing a week later.

**Smallest reliable reconciliation:**

The gate in Step 3 is the load-bearing piece. Everything else is defense-in-depth. If only one thing ships, it must be the pre-submit invariant check against `job.photos` ↔ `__photoStates`.

---

## F. Pagination / no-bad-split rules

All rules are expressed as pre-measure-then-guard invariants. A "block" is an atomic unit: if it doesn't fit in the remaining page, the whole block moves to the next page before any draw happens.

| Block | Atomicity rule |
|---|---|
| Question label + first line of answer (non-photo field) | Pre-measure `blockH = max(labelLines, valueLines) * 4 + 2`. If `y + blockH > 280` → `addPage()` before drawing. This rule already exists at `generate-pdf.ts:456-461` for non-photo fields; preserve it. |
| Remarks/notes label + first line of remarks text | Same pre-measure pattern. Remarks fields currently render through the non-photo branch; this rule is already satisfied. |
| Remarks/notes label + first line of text + first photo row | **New in rv3 (remarks gain photos).** Pre-measure `labelH + firstLineH + firstPhotoH + margins`. If won't fit → `addPage()` before drawing any of it. |
| Photo field label + first image | Already guarded for Q108 at `generate-pdf.ts:308-312` (the `firstBelowH` computation) and for single-photo fields at `generate-pdf.ts:400-404`. **Extend this pattern** to every non-Q108 photo field uniformly; do not trust that each branch guards itself. |
| Multi-photo grid (up to 4 images) | Grid header (label) + first row of images is atomic. Second row of images paginates independently (can break between row 1 and row 2 if needed, but never inside a row). Pre-measure `labelH + rowH + margin` for the first-row guard. |
| Summary-item heading + first line of text | New block type. Atomic: `headingH + firstLineH + margin`. If won't fit → `addPage()`. |
| Summary-item heading + first line of text + first photo row | When a summary item has both text and photos, the entire trio is atomic on first-render of the item. Subsequent photo rows paginate independently. |
| Q108 "Additional Photos" label + first drain image | Already guarded via the deferred-label pattern at `generate-pdf.ts:292-332`. Preserve this pattern; do not simplify. |
| Signature page block (worker signature + submittedBy + date) | Already guarded by the `y > 230` check at `generate-pdf.ts:503-506`. Extend with the rv3 "Submitted by: <tech>" label (§G). |

**Enforcement convention (no "write first, paginate later"):**

Every `doc.text(...)` or `doc.addImage(...)` inside the field-iteration loop MUST be preceded by a computed `blockHeight` and a conditional `addPage`. Zero draw-then-paginate paths allowed. This mirrors the existing Q108 discipline and extends it uniformly.

**Continuation behavior for blocks taller than one page:**

Deferred to a later task. For rv3, the only field type that could plausibly exceed one page is Q107 Summary with 20 photos. This is handled by per-row pagination (rows paginate independently after the first atomic line), not by a continuation-row rule. If customer later reports a summary item that needs a "(continued on next page)" header, add it then.

---

## G. PDF cleanup

**Verified against current `src/lib/actions/generate-pdf.ts`:**

1. **Remove the page-1 "Submitted by" / date block.** Current code at `generate-pdf.ts:139-148` conditionally renders `"Submitted by: X  |  Date: Y"` directly under the job title. Delete this entire `if (job.submittedBy || job.submittedAt)` block. (The job title at `generate-pdf.ts:132-137` is `job.name` / `job.jobNumber`, which is the report's job identifier — keep it. The customer's "remove the name/date block above Q1/Q2" is about the submitted-by/date pair, not the job title itself.)

2. **Confirm "customer_name" is not rendered as a page-1 header anywhere.** Grep `generate-pdf.ts` for `customer_name` and `formData["customer_name"]`. Expected: it appears only through the normal field-iteration loop (it's field Q1 "Customer Name" with `order: 0` in `DEFAULT_TEMPLATE`). If it appears as a page-1 header outside the loop, remove that occurrence. Verified as of 2026-04-18: no such extra occurrence exists; the grep returns zero matches outside the iteration.

3. **Add "Submitted by" label on the signature page.** Current code at `generate-pdf.ts:529-534` renders `doc.text(job.submittedBy, MARGIN, y)` — just the plain name. Change to `"Submitted by: " + job.submittedBy` (one string). Keep the date rendering at `generate-pdf.ts:535-537` unchanged.

4. **Cross-check no duplicate "customer name" / "submitted by" / "date" appears elsewhere.** After items 1–3 are applied, run `grep -nE "(submittedBy|submitted_by|customer_name|\.submittedAt)" generate-pdf.ts` and verify the remaining hits are only: (a) signature-page block, (b) nothing on page 1.

**Files touched in §G:** `src/lib/actions/generate-pdf.ts` only.

**Not re-opened (per frozen baseline):** Header/logo line fix, signature divider removal, fake sections removal, Kimberly orphan-filename gate fix. None of these are touched by §G.

---

## H. Resend button

**Where it lives:**

- New Server Action `resendJobSubmission(jobId)` in `src/lib/actions/submit.ts` (same file as `submitJob`, reuses the preflight-and-send helpers).
- UI entry point: a new "Resend submission email" button on the job detail view (`src/app/jobs/[id]/page.tsx` or equivalent — grep for where `submitJob` is currently wired; mirror its pattern). If an admin view exists at `/admin/jobs/[id]`, the button also renders there.
- Button enabled only when `job.status === "SUBMITTED"`. Disabled otherwise with a helper label "Only submitted jobs can be resent."

**What it sends:**

- Regenerates the PDF via `generateJobPdf(jobId)` — same code path, so any PDF changes since the original submit (bug fixes, layout changes) will apply.
- Regenerates the HTML body via `buildSubmissionEmail(...)` — same thing, includes whatever the editable-version work from §D has shipped.
- If §D D1 (edit link) is shipped, the resend reissues a fresh 30-day-from-now edit token and embeds it in the new email.
- Sends to the same recipient from `getRecipientEmail()`. No override option in v1 (keep scope tight).

**Allowed states:**

- `SUBMITTED` — allowed
- `DRAFT` — rejected with "Submit the job first, then use Resend if needed"
- `ARCHIVED` — rejected with "Archived jobs cannot be resent" (scope-safe default; can relax later)

**Interaction with editable-version (§D):**

- Resend is the same send path as submit for email purposes; the editable-version content is generated identically. There is no "only the PDF" variant in v1.
- If D1 is shipped, resend reissues an edit token with fresh 30-day expiry. The old token is not explicitly invalidated (expiry will catch it); an "invalidate prior tokens" option can be added later if needed.

**Idempotency / rate limit:**

- No DB writes other than a lightweight audit trail: append to a new reserved `__resendLog` key in `formData` — an array of `{ sentAt, sentBy }`. This is additive, preserved by autosave guard.
- Client-side button disable for 10 seconds after click (prevent double-click rapid sends). No server-side rate limit in v1; can be added if abused.

**Does NOT do:**

- Does not re-run the submit validation (submitted jobs are by definition valid; re-validating would block legitimate resends if data changed post-submit).
- Does not accept overrides (recipient, subject) in v1.

---

## I. What remains valid from Tasks 1–2

### Task 1 (`src/lib/multi-photo.ts`, `src/lib/summary.ts`, widened `FormData`)

| Symbol / artifact | Status in rv3 | Notes |
|---|---|---|
| `MULTI_PHOTO_FIELD_IDS` (Set of 5 field IDs) | **Valid** | Identical set of 5 multi-photo fields. No change. |
| `MULTI_PHOTO_CAP = 4` | **Deprecated** | Replaced by per-field `PHOTO_CAPS` map (Q5=3, Q16=3, Q25=2, Q40=3, Q71=4). The constant should stay exported for back-compat with any consumer we haven't found yet, but annotate with `@deprecated use PHOTO_CAPS[fieldId]` and update call sites. |
| `RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField"` | **Valid** | Still the authoritative storage key for multi-photo slots. Unchanged. |
| `REVIEWED_FLAG = "__photoAssignmentsReviewed"` | **Valid** | Still gates the Pass 2 legacy fallback in `generate-pdf.ts`. Unchanged. |
| `readFieldPhotoUrls(formData, fieldId)` | **Valid** | Helper stays as-is. Cap enforcement is separate from reading. |

### Task 1 (`src/lib/summary.ts`)

| Symbol / artifact | Status in rv3 | Notes |
|---|---|---|
| `SummaryItem` type (`{ text: string; photos: string[] }`) | **Valid** | Shape unchanged. Ownership is now also recorded in `__photoStates[url].owner = "__summary_item_<ordinal>"` (new, additive). |
| `RESERVED_SUMMARY_KEY = "__summary_items"` | **Valid** | Unchanged. |
| `SUMMARY_PHOTO_SOFT_LIMIT = 25` | **Deprecated** | No soft/hard split in rv3; single cap. Delete or leave as `@deprecated`; do not consult in new code. |
| `SUMMARY_PHOTO_HARD_LIMIT = 40` | **Deprecated** | Replaced by `SUMMARY_PHOTO_CAP = 20` (customer new number). |
| `parseSummaryItems(formData)` | **Valid** | Parse logic unchanged. |
| `countSummaryPhotos(items)` | **Valid** | Still the right way to count for the 20-cap check. |
| `collectSummaryPhotoUrls(items)` | **Valid** | Still needed for photo-claim accounting. |

### Task 1 (`src/lib/forms.ts`)

| Symbol / artifact | Status in rv3 | Notes |
|---|---|---|
| `FormData = Record<string, unknown>` widening | **Valid and load-bearing** | `__photoStates` is additive and relies on this widening. Do not narrow. |

### Task 2 (`src/lib/actions/forms.ts` — `saveFormData`)

| Behavior | Status in rv3 | Notes |
|---|---|---|
| Fresh DB read on every call | **Valid and critical** | `__photoStates` inherits this protection. Any photo-state write happens via a dedicated action (`setPhotoInclude`, `assignMultiFieldPhotos`, etc.); RHF autosave never touches it. |
| `__`-prefix strip from client payload | **Valid and critical** | Explicitly handles `__photoStates` for free (starts with `__`). No new code path needed. |
| `undefined` filter before merge | **Valid** | Unchanged. |
| Atomic `updateMany` with `status: "DRAFT"` guard | **Valid** | Unchanged. |
| Structural integrity check (templateFields.length ≥ 20 ∧ missing > 50%) | **Valid** | Unchanged; adjusts naturally to new template fields (none added in rv3). |
| Test suite `src/__tests__/actions/forms.test.ts` | **Valid** | Covers autosave-preserve; add at least one new test case for `__photoStates` preservation (same shape as the `__summary_items` case). |

### Invalidated mpf assumptions

- **"Q108 is the drain bucket for all leftovers"** → Invalid. Q108 is now a 5-cap bucket with explicit membership. Orphan photos block submit (§C, §E).
- **"Uniform 4-cap for all multi-photo fields"** → Invalid. Per-field caps (§B).
- **"Summary soft/hard 25/40 split"** → Invalid. Single 20-cap.
- **"Remarks fields are text-only"** → Invalid. 8 remarks fields gain photo support, cap 6 each.
- **"Email body doesn't render summary content inline → Task 11 decides no email.ts changes"** → Partially invalidated. Task 11's decision premise still holds (summary content is not in the email today), but rv3 adds a new requirement: the email body must render an editable-version view with per-photo owner labels and excluded-photos thumbnails. So `src/lib/email.ts` IS touched in rv3 — not because of summary content, but because of the §D editable-version ask. The Task 11 EMAIL-DECISION.md file, if it exists, should be updated to reflect this.
- **"One photo has exactly one owner field"** → Still valid for v1. No change.

---

## J. Database / photo record strategy

**Source of truth:**

- **Binaries** — Vercel Blob (existing; `@vercel/blob`). No change.
- **Metadata** — `Job.photos: Json @default("[]")` (existing; `prisma/schema.prisma:50`) storing `PhotoMetadata[]` (`{ url, filename, size, uploadedAt }`). No change, no migration.
- **State (owner + include)** — `Job.formData.__photoStates` (new reserved key; lives inside the existing `Job.formData: Json?` column). Shape defined in §A.

**No Prisma migration in rv3.** All new state is JSON inside existing columns. CLAUDE.md prohibits `prisma migrate` against the current Neon DB; `npx prisma db push` is not needed either because no schema shape changes.

**Minimum photo record/state fields needed:**

- In `Job.photos[]` (existing, unchanged): `url` (identity), `filename`, `size`, `uploadedAt`.
- In `Job.formData.__photoStates[url]` (new):
  - `owner: string | null` — the photo's editable home. Values: `fieldId` (numbered question or remarks field), `"__summary_item_<ordinal>"`, `"108_additional_photos"`, or `null` (unassigned).
  - `include: boolean` — `true` = render in PDF; `false` = keep in DB and editable version, skip in PDF.
  - `setAt: string` — ISO timestamp of when the state was last written. Audit trail; useful for forensics of "when did this photo's assignment change?"

**Why this minimum set:**

- `owner` + `include` are the two dimensions customer explicitly asked for (assignability + exclude-from-PDF-while-retaining-in-editable).
- `setAt` is cheap to compute (`new Date().toISOString()` on every write) and makes every assignment auditable without a separate log table. Satisfies the "no silent disappearance" audit requirement in §E with one field.
- No other fields needed in v1. Resist adding `assignedBy: string` or `lockedBy: string` — scope creep without a customer request.

**Reads/writes — principle:**

- Every state write goes through a named server action: `assignMultiFieldPhotos`, `assignRemarksFieldPhotos`, `assignAdditionalPhotos`, `setPhotoInclude`, `saveSummaryItems`. Never via `saveFormData`.
- `saveFormData` (autosave) continues to strip `__`-prefixed keys from the client payload (shipped in Task 2) — a defense-in-depth guarantee that a confused client can't overwrite `__photoStates`.
- PDF render reads `__photoStates` as the authoritative map for owner + include decisions. Legacy-shape jobs (no `__photoStates` at all) fall back to the existing 3-pass resolver (this preserves the T9 legacy byte-equivalence truth from mpf).

---

## Changed assumptions list

| mpf assumption (old) | rv3 replacement (new) |
|---|---|
| Q5/Q16/Q25/Q40/Q71 share a uniform 4-photo cap | Per-field caps: 3 / 3 / 2 / 3 / 4 |
| Q107 Summary: soft 25 / hard 40 photo cap | Single cap: 20 |
| Q108 Additional Photos: unbounded drain for leftovers | Bounded bucket: cap 5; explicit membership only; no drain |
| Unassigned photos auto-drain to Q108 at render time | Unassigned photos BLOCK submit unless explicitly `include = false` |
| Remarks/notes fields (Q15, Q33, Q72, Q76, Q79, Q83, Q91, Q102) are text-only | Each remarks field supports up to 6 photos alongside text |
| Email body renders form fields + photos, never summary | Email body is the editable-version surface (§D D2); renders owner-labeled photos including excluded ones |
| "Editable version" was not a requirement | Editable version is a customer ask; layered D2 (HTML email body) now, D1 (tokenized edit link) later |
| Resend was not a requirement | Resend button exists on job detail; SUBMITTED-only; same send path; optional audit via `__resendLog` |
| Photo ownership tracked only as `formData[fieldId]` or `__photoAssignmentsByField[fieldId]` | Photo ownership plus include/exclude state tracked in new `__photoStates[url]` |
| Submit preflight checks required fields and email configuration | Submit preflight ALSO runs §E reconciliation: every `job.photos[].url` must have `__photoStates` entry |
| PDF "Submitted by: X | Date: Y" renders on page 1 | Removed from page 1; "Submitted by: <name>" rendered on signature page with label prefix |
| Kimberly-class orphan-filename bug was the main reliability concern | Mixed-device orphan-photo loss is the primary reliability concern; reconciliation gate addresses it; orphan-filename fix is still shipped |
| PDF fails to render excluded photos (no such concept) | PDF SKIPS `include = false` photos at render; editable version surfaces them |

---

## Which old tasks remain valid

**Task 1 artifacts (shipped in commit `e96d55a`) — status:**

- `MULTI_PHOTO_FIELD_IDS` — **VALID**, unchanged
- `MULTI_PHOTO_CAP = 4` — **DEPRECATED**, replaced by per-field `PHOTO_CAPS` map
- `RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField"` — **VALID**, unchanged
- `REVIEWED_FLAG = "__photoAssignmentsReviewed"` — **VALID**, unchanged
- `readFieldPhotoUrls(formData, fieldId)` — **VALID**, unchanged
- `RESERVED_SUMMARY_KEY = "__summary_items"` — **VALID**, unchanged
- `SummaryItem` type — **VALID**, unchanged
- `SUMMARY_PHOTO_SOFT_LIMIT = 25` — **DEPRECATED** (no soft tier in rv3)
- `SUMMARY_PHOTO_HARD_LIMIT = 40` — **DEPRECATED**, replaced by `SUMMARY_PHOTO_CAP = 20`
- `parseSummaryItems(formData)` — **VALID**, unchanged
- `countSummaryPhotos(items)` — **VALID**, unchanged
- `collectSummaryPhotoUrls(items)` — **VALID**, unchanged
- `FormData = Record<string, unknown>` widening (`src/lib/forms.ts`) — **VALID and load-bearing** for rv3's new `__photoStates` key

**Task 2 behavior (shipped in commit `0ea2f9e`, `src/lib/actions/forms.ts::saveFormData`) — status:**

- Fresh DB read on every call — **VALID and critical** (rv3 inherits this)
- `__`-prefix strip from client payload — **VALID and critical** (automatically protects `__photoStates`)
- `undefined` filter before merge — **VALID**
- Atomic `updateMany` status guard — **VALID**
- Structural integrity check (50%+ missing triggers reject) — **VALID**
- Test suite at `src/__tests__/actions/forms.test.ts` — **VALID**; add rv3 test cases for `__photoStates` preservation and for an unassigned-photo pre-submit reject

**Task 3 onwards from mpf — SUPERSEDED BY RV3.** Do not reopen mpf Tasks 3–12; rv3 replans them with per-field caps, remarks-photo support, reliability gate, editable version, and resend button.

---

## Recommended new execution order

**Phase 1 — State model foundation (lands before any UI or render work):**

| # | Title | Files touched | Why in this phase |
|---|---|---|---|
| 1 | Shared per-field caps + `__photoStates` shape | `src/lib/multi-photo.ts` (new `PHOTO_CAPS` map; deprecate `MULTI_PHOTO_CAP`), `src/lib/summary.ts` (new `SUMMARY_PHOTO_CAP = 20`; deprecate 25/40), new `src/lib/photo-state.ts` (types + `RESERVED_PHOTO_STATES_KEY = "__photoStates"`, helpers `readPhotoState`, `getOwner`, `getInclude`, `isOrphan`) | Every downstream task depends on these constants and helpers. Pure-data, zero behavior change in isolation. |
| 2 | Photo-state server actions | `src/lib/actions/photo-assignments.ts` (extend; add `setPhotoInclude`, `assignRemarksFieldPhotos`, `assignAdditionalPhotos`, update `assignMultiFieldPhotos` to per-field cap), draft-only + ownership + cap validation in every action | Lands before any UI calls them. Unit-testable in isolation. |
| 3 | Pre-submit reconciliation gate | `src/lib/actions/submit.ts` (extend `submitJob`) | Blocks orphan submits before any UI work ships — worst-case a submit just blocks with a clear error, no silent loss window. |

**Phase 2 — PDF render alignment:**

| # | Title | Files touched | Why in this phase |
|---|---|---|---|
| 4 | PDF cleanup (page-1 submit-metadata removal; signature-page "Submitted by:" label) | `src/lib/actions/generate-pdf.ts` (lines 139-148 delete; 529-534 prefix) | Independent customer-directive cleanup. Can ship before the bigger render rework. |
| 5 | PDF render respects `__photoStates` + include/exclude + render manifest | `src/lib/actions/generate-pdf.ts` (new Pass 0 builds manifest from `__photoStates`; existing 3-pass stays as legacy fallback for jobs without `__photoStates`) | Requires Phase 1. Establishes render-manifest cross-check for §E. |
| 6 | Uniform pagination guard extension (all fields, including new remarks-with-photos) | `src/lib/actions/generate-pdf.ts` (extend the pre-measure pattern to every branch) | Low-risk pattern generalization. |

**Phase 3 — UI per surface:**

| # | Title | Files touched | Why in this phase |
|---|---|---|---|
| 7 | Multi-photo field UI with per-field caps | `src/components/multi-photo-field.tsx` (new), `src/components/job-form.tsx` (FieldRenderer branch) | Replaces mpf Task 6 with cap-aware version. Caps read from Phase 1's `PHOTO_CAPS`. |
| 8 | Remarks-field photo attachments UI (new) | `src/components/remarks-photo-attachments.tsx` (new), `src/components/job-form.tsx` (extend textarea FieldRenderer branch for the 8 remarks IDs) | New surface; independent of Q107 summary editor. |
| 9 | Summary items editor with 20-cap | `src/components/summary-items-editor.tsx` (new; replaces mpf Task 9), `src/components/job-form.tsx` | Depends on Phase 1 `SUMMARY_PHOTO_CAP`. |
| 10 | Admin photo-assignments UI with per-photo exclude toggle | `src/components/photo-assignments.tsx` (extend current single-`<select>`: add exclude checkbox; add per-field slot selector for multi-photo fields with respective caps; add remarks-field targets; add summary-item target grouping) | Office-facing; lands after field-level UIs so admins have something to oversee. |
| 11 | Pending-assignments banner + submit-blocking UI | `src/components/job-form.tsx` (or a new top-banner component) | Surfaces orphan list + deep-link to assignments view. |

**Phase 4 — Email + resend:**

| # | Title | Files touched | Why in this phase |
|---|---|---|---|
| 12 | Editable version (D2) — email body with owner labels + excluded-photos section | `src/lib/email.ts` (major extension; add owner rendering + excluded section; reuse existing escapeHtml and photo thumbnail pattern) | Single-task readable editable version. No new deps. |
| 13 | Resend button + `resendJobSubmission` action | `src/lib/actions/submit.ts` (add `resendJobSubmission`), `src/app/jobs/[id]/page.tsx` (UI button) | Requires Phase 1 and Phase 4 task 12. |
| 14 | (Optional, can defer) Edit link (D1) — tokenized post-submit edit route | new route `src/app/jobs/[id]/edit-post-submit/...`, new helper `src/lib/edit-token.ts`, email body integration | Highest build cost; deferable until D2 proves insufficient. |

**Phase 5 — Reliability + regression:**

| # | Title | Files touched | Why in this phase |
|---|---|---|---|
| 15 | Regression suite: pre-submit gate, photoStates preservation through autosave, render manifest, exclude semantics, per-field cap rejections | `src/__tests__/regression/rv3-*.test.ts` + fixtures | Final check; covers the biggest-risk invariants. |
| 16 | Legacy byte-equivalence check (jobs without `__photoStates`) | Same test suite | Prove no regression on shipped jobs; inherit mpf Proof 1 approach. |

---

## Biggest risks first

1. **Silent photo loss on mixed-device sessions (Jimmy's original complaint).**
   *Mitigation:* §E pre-submit reconciliation gate (Phase 1 Task 3). Every `job.photos[].url` must have a `__photoStates` entry before submit; otherwise submit rejects with explicit orphan list.
   *What catches it if it breaks:* regression test in Phase 5 Task 15 (fixture: job with photos but no state entries → submit must return error, email must not send). Render manifest cross-check in Phase 2 Task 5 catches it at the next layer if somehow an orphan slips through the submit gate.

2. **`__photoStates` clobber via autosave — the same class of bug Task 2 fixed.**
   *Mitigation:* Task 2 (`src/lib/actions/forms.ts`) already strips every `__`-prefixed key from client payload. `__photoStates` inherits this protection for free.
   *What catches it if it breaks:* new test case in `src/__tests__/actions/forms.test.ts` asserting `__photoStates` is preserved across autosave (same shape as the `__summary_items` case already covered).

3. **Legacy-job regression — pre-mpf/pre-rv3 jobs render differently after the new code ships.**
   *Mitigation:* `__photoStates`-absent jobs fall back to the existing 3-pass resolver in `generate-pdf.ts` unchanged. PDF render code path branches on `formData["__photoStates"] != null`; else legacy 3-pass runs.
   *What catches it if it breaks:* Phase 5 Task 16 legacy byte-equivalence check. Pick 3 fixtures (one reviewed, one unreviewed, one with Kimberly-class orphan filename); regenerate PDFs before/after rv3; `pdftotext` diff must be zero.

4. **Per-field cap regressions — existing draft jobs with over-cap assignments crash on render or refuse to load.**
   *Mitigation:* cap enforcement is server-side at write time; existing DB data may already violate the new caps (e.g. a legacy Q5 with 4 photos). PDF render truncates + warns (never crashes; never silent).
   *What catches it if it breaks:* explicit test fixture with an over-cap legacy Q5 — expect truncation, not crash.

5. **Editable-version email (D2) renders incorrectly in Outlook / Gmail / mobile clients.**
   *Mitigation:* reuse the existing inline-CSS, table-based pattern from `src/lib/email.ts` (proven across clients). Every excluded-photo thumbnail uses the same `<img>` attributes as today's photos section.
   *What catches it if it breaks:* React Email preview (`npx react-email dev`) for local visual check; a staging-inbox send for each supported client before the resend button ships publicly.

6. **Edit link token forgery (if D1 ships).**
   *Mitigation:* HMAC-SHA256 signing with a dedicated env var (`JOB_EDIT_LINK_SECRET`), jobId + expiry baked into the signed payload. Server validates signature on every request.
   *What catches it if it breaks:* unit test for token signing/verification round-trip, plus an explicit "tampered token" case that must reject.

7. **PDF render manifest itself silently drops photos (the watcher-watches-itself problem).**
   *Mitigation:* manifest cross-check at end of `generateJobPdf` compares manifest URLs to `job.photos[].url`. Mismatch → fail-loud return value; submit does not send email. A manifest bug cannot silently succeed.
   *What catches it if it breaks:* regression fixture with 10 photos split across all owner types; assert manifest length === 10, manifest entries have every owner type, no duplicates, no omissions.

8. **Scope creep into "editable version" expansion (D4-style Word/Google Doc export).**
   *Mitigation:* D2 ships first. D1 is queued. D4 is explicitly out of scope for rv3. Any ask to "also generate a Word doc" is a new quick-task.
   *What catches it if it breaks:* rv3 DELTA itself (this document) is the reference — if a task starts pulling in `.docx` libs or Google API deps, stop.
