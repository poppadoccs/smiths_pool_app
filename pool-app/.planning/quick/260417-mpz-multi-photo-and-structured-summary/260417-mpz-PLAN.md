---
id: 260417-mpz
title: Multi-photo numbered questions + structured summary
date: 2026-04-17
status: ready_for_review
tasks: 9
---

# Goal

Extend the shipped PDF pipeline so the 5 eligible numbered questions (Q5, Q16, Q25, Q40, Q71) each accept up to 4 photos, and replace the single-blob summary with a structured list of items, each carrying its own text and photos. All single-slot photo fields, Q108 drain, Pass 2 gate, reviewed sentinel, numbering, signature block, and existing submitted jobs must render unchanged.

**Execution order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Tasks 1 and 2 unlock everything else; 4 and 5 can land in either order once 3 ships; 6 must land before 7; 7–8 are the PDF/email side; 9 wraps verification.

# Background

Today `Job.formData: Record<string, string | boolean>` stores exactly one value per field keyed by template field id. Photo fields hold a single URL-or-filename string; the 3-pass resolver in `src/lib/actions/generate-pdf.ts` consumes that scalar. The shipped admin photo-assignment UI writes `formData[fieldId] = url` 1:1 during the reopened-draft flow. The summary today is a single long text field — no structured items, no attached photos.

Field crews routinely have more than one photo per concern (before/after, wide/detail, multiple angles for Q25 equipment). The single-slot contract forces them into Q108 with no association to a question. On the reviewer side, the summary blob is hard to act on because referenced photos aren't tied to the comment.

This slice relaxes exactly those two bottlenecks without touching anything else. The primary risk is breaking backward compat for the ~100 already-submitted jobs and the shipped 3-pass resolver's Pass 2 sequential fallback, so storage choice and resolver extension are the two load-bearing decisions below.

**mp3 stub decision: SUPERSEDE.** The prior stub scoped multi-photo only; this plan bundles the structured summary because the Q108 leftover computation has to subtract both claim sources in one pass — splitting the work across two slices would force a second resolver rewrite.

## Decision 1: Structured storage — Option B wins

**Option A (rejected):** `formData["5"] = [url1, url2, ...]`.
**Option B (chosen):** `formData["__photoAssignmentsByField"] = { "5": [url1, url2] }`; `formData["5"]` is left legacy (empty for new multi-photo jobs, the original single URL for old jobs).

Why B beats A:

- **Type contract:** `FormData` today is `Record<string, string | boolean>`. Option A forces a union with `string[]`, which touches `buildFormSchema`, `getDefaultValues`, every `typeof rawValue === "string"` branch in the PDF/email code, and react-hook-form's field-level types. Option B adds one reserved key with an explicit sub-type; all single-slot field code paths are untouched.
- **Resolver blast radius:** Pass 1 in Option B gains one extra lookup (`map[fieldId] ?? formData[fieldId]`). Pass 2 sequential fallback has a single map to consult for "already claimed" — O(1) per URL. Option A forces Pass 2 to type-check every scalar to detect arrays.
- **Legacy read-compat:** Old jobs have no `__photoAssignmentsByField`, so the map read yields `undefined` → falls through to legacy scalar read unchanged. Option A requires either migrating all legacy photo values to `[url]` arrays or branching everywhere.
- **Admin photo-assignment UI:** The shipped 1:1 writer at `formData[fieldId] = url` keeps working unchanged for non-multi fields. The extension writes `formData.__photoAssignmentsByField[fieldId]` as a separate path — minimal diff.
- **Debug/forensic reads:** `formData[fieldId]` for single-slot fields stays a scalar, so existing scripts and email renderers that dump the record stay readable. Assignments live in one obvious reserved key.
- **Reserved-key collision risk:** Template field ids in `DEFAULT_TEMPLATE` and the scanner output are digits or snake_case (`customer_name`, `108_additional_photos`). `__photoAssignmentsByField` (double-underscore prefix) cannot collide unless someone intentionally scans a field named that. The template editor can add a blocklist check; negligible risk.

## Decision 2: 3-pass resolver extension

The resolver is gated by `hasAnyResolvableExplicit`. Extension rules:

- **Pass 1 (explicit):** For every photo field `f`, first consult `formData.__photoAssignmentsByField?.[f.id]`. If present and non-empty, resolve each URL (match against `job.photos[].url` or filename); these become `f`'s photos in order. Else fall back to the legacy `formData[f.id]` scalar read. Set `hasAnyResolvableExplicit = true` if any field resolved anything.
- **Pass 2 (sequential fallback):** Unchanged gate (`hasAnyResolvableExplicit === false`). When it runs, it skips any field that already has an entry in `__photoAssignmentsByField` regardless of array length. Rationale: a field that opted into multi-photo owns its slots explicitly; sequential fallback into a multi-photo field would be non-deterministic (which of 4 slots?). For legacy jobs with no map, Pass 2 behaves exactly as before — Q5/Q16/Q25/Q40/Q71 are single-photo and participate normally.
- **Summary claims:** Pass 1 also consumes URLs referenced by `formData.summary_items[].photos`.
- **Q108 drain:** Leftover = `job.photos` minus {URLs claimed by `__photoAssignmentsByField`} minus {URLs claimed by any legacy scalar photo field} minus {URLs claimed by `summary_items[].photos`}. Order preserved from `job.photos` (upload order).
- **Ordering within a multi-photo field:** The array order in `__photoAssignmentsByField[fieldId]` is authoritative. UI writes control it.

## Decision 3: Per-field upload UX (JobForm)

For the 5 eligible fields only, the `case "photo"` branch in `src/components/job-form.tsx:398` renders a mini-card:

- Thumbnail row of currently-assigned photos (reads `__photoAssignmentsByField[fieldId]`, resolves against `job.photos[].url`).
- "+ Add photo" button → drawer that lists unclaimed photos from `job.photos` plus a "Take new" CTA (reuses existing `PhotoUpload` flow, then auto-appends the new URL to this field's array).
- Per-thumb remove (unclaim) and up/down chevrons for reorder. No drag-and-drop — iPad Safari drag is flaky and chevrons work with gloves.
- "N of 4" counter; Add button disabled at cap.

All other `type: "photo"` fields keep today's single-slot rendering — no change.

## Decision 4: Admin photo-assignment UI extension

The shipped component writes `formData[fieldId] = url`. Extension (single diff, gated on `fieldId ∈ ELIGIBLE_FIELD_IDS`):

- Checkbox/multi-select for the 5 eligible fields; single radio for every other photo field (unchanged).
- On save, eligible fields write `formData.__photoAssignmentsByField[fieldId] = [url, ...]`; non-eligible fields continue to write `formData[fieldId] = url`.
- The photo-assignment server action (separate file from `src/lib/actions/photos.ts`, which is off-limits) validates the cap and eligibility server-side and refuses writes that violate either.

## Decision 5: PDF layout for 1–4 photos

Use the shipped `fitPhoto` helper for sizing and the existing page-break pre-measure pattern from `generate-pdf.ts:120` (measure full block = label + photo grid, break before drawing anything).

- **1 photo:** single centered image, width ≈ 110mm.
- **2 photos:** side-by-side row, each ≈ 85mm wide.
- **3 photos:** row of 3, each ≈ 55mm wide.
- **4 photos: 2×2 grid** (not 1×4). Justification: A4 content width is 180mm; 1×4 yields ~40mm-wide thumbnails which lose equipment labels and damage detail. 2×2 gives ~85mm × 64mm cells — same scale as the 2-photo layout, readable for insurance/warranty context. Added page height (~68mm vs ~34mm) is worth it; we already page-break as a unit.

Ordering follows array order. Label never orphans — the whole (label + grid) block is measured and broken together.

## Decision 6: Summary schema + capacity policy

**Schema (lives in formData — no Prisma migration):**

```ts
formData["summary_items"]: { text: string; photos: string[] }[]

Read-side adapter (in generate-pdf.ts, email.ts, and wherever else we render summaries):

const items =
  (formData.summary_items as SummaryItem[] | undefined)
  ?? (typeof formData.summary === "string" && formData.summary.trim()
        ? [{ text: formData.summary, photos: [] }]
        : []);

No forced migration. Old jobs with formData.summary render as a single item with no photos; new jobs with summary_items render as multiple items.

Capacity policy — real numbers:

Per-item photo cap: 4 (reuses the multi-photo layout; same cell sizing reduces code surface).

Soft warnings / hard stops:

Soft warning at 8 items. Toast "Long summaries get truncated by some email clients — consider splitting into a second job." Rationale: 8 items × 4 photos = 32 photos of summary content. Field inspector interviews and pilot data suggest typical submissions run 3–6 summary items; 8 covers the 95th percentile of real flows without nagging.
Soft warning at 16 summary photos (whichever threshold hits first).
Hard stop at 15 items and 30 summary photos (UI refuses to add more, server action rejects).
Math behind the caps:

Compressed JPEGs from iPad are ~400–700KB after COMPRESSION_OPTIONS (maxSizeMB: 1, 1920px, q=0.8). Call it 500KB nominal.
jsPDF addImage with JPEG input stores the image roughly as-is (~500KB/photo in the PDF stream) plus ~10KB per embed overhead. CPU cost per embed on Vercel's serverless tier: ~30–80ms.
Ceiling budget per submission: numbered-question photos (5 fields × 4) = 20 + summary (30 cap) + Q108 leftovers (realistic ~10–15). Worst case ≈ 65 photos.
PDF size: 65 × 500KB ≈ 32.5MB of images + ~200KB of text/layout ≈ ~33MB.
Email payload: PDF attachment base64-encoded = 33MB × 1.37 ≈ 45MB raw, but Resend's 40MB limit is the decoded attachment size — 33MB fits under it with ~7MB of headroom. HTML body + signature are <100KB, negligible.
jsPDF serverless runtime at 65 photos × 50ms = ~3.3s embed time, under the 10s Vercel Fn default.
Therefore: the 30-summary-photos + 20-numbered + Q108 ceiling is the ceiling that keeps us under Resend's 40MB hard wall with measurable slack. 15 items × 4 photos = 60 theoretical, but the 30 cap is the binding constraint.
must_haves
must_haves:
  truths:
    - "Storage uses Option B: formData.__photoAssignmentsByField: Record<fieldId, string[]> for the 5 eligible fields only"
    - "Single-slot photo fields keep writing to formData[fieldId] as a scalar; no change"
    - "Pass 1 reads map first, then legacy scalar; Pass 2 skips fields with map entries; Q108 drain subtracts all claim sources"
    - "Eligible multi-photo field set is exactly {5, 16, 25, 40, 71}; hard cap 4 each; enforced server-side"
    - "summary_items schema lives in formData; read-side adapter falls back to legacy formData.summary text blob"
    - "Summary caps: soft-warn at 8 items or 16 photos; hard-stop at 15 items and 30 photos"
    - "Legacy submitted jobs render byte-for-byte equivalent under new code (one photo per eligible field, original summary blob)"
    - "One photo has exactly one owner: numbered slot OR summary item OR Q108 — no sharing, no duplication"
  artifacts:
    - path: "pool-app/src/lib/forms.ts"
      provides: "FormData type extension (reserved keys), SummaryItem type, ELIGIBLE_MULTI_PHOTO_FIELDS constant, MAX_PHOTOS_PER_FIELD=4, SUMMARY_* caps"
    - path: "pool-app/src/lib/actions/generate-pdf.ts"
      provides: "Pass 1 map lookup, Pass 2 multi-photo skip, Q108 drain subtraction, multi-photo PDF grid renderer, structured summary renderer"
    - path: "pool-app/src/components/job-form.tsx"
      provides: "Per-field multi-photo card for eligible fields, summary-editor integration"
    - path: "pool-app/src/components/summary-editor.tsx"
      provides: "Add/remove/reorder summary items with per-item text + photo picker, cap enforcement"
    - path: "pool-app/src/lib/email.ts"
      provides: "Per-item summary rendering with inline photo thumbnails"
  key_links:
    - from: "job-form.tsx photo field renderer"
      to: "formData.__photoAssignmentsByField"
      via: "Controller value ↔ reserved key read/write"
    - from: "generate-pdf.ts Pass 1"
      to: "formData.__photoAssignmentsByField && formData.summary_items"
      via: "explicit claim lookup before legacy scalar fallback"
    - from: "admin photo-assignment server action"
      to: "ELIGIBLE_MULTI_PHOTO_FIELDS + MAX_PHOTOS_PER_FIELD"
      via: "server-side validation of cap + eligibility"

Tasks
Task 1 — Types and constants
files: pool-app/src/lib/forms.ts
action:

Add SummaryItem = { text: string; photos: string[] }.
Change FormData to Record<string, string | boolean> & { __photoAssignmentsByField?: Record<string, string[]>; summary_items?: SummaryItem[]; summary?: string } (intersection keeps the open record while typing the reserved keys).
Export ELIGIBLE_MULTI_PHOTO_FIELDS = ["5","16","25","40","71"] as const, MAX_PHOTOS_PER_FIELD = 4, MAX_SUMMARY_ITEMS = 15, MAX_SUMMARY_PHOTOS_TOTAL = 30, SUMMARY_WARN_ITEMS = 8, SUMMARY_WARN_PHOTOS = 16.
buildFormSchema leaves reserved keys unvalidated (pass-through); do not add them to the Zod shape.
verify: npx tsc --noEmit clean; existing tests green.
done: Types compile; constants exported; no schema changes to single-slot field validators.
Task 2 — Resolver extension (Pass 1 / Pass 2 / Q108 drain)
files: pool-app/src/lib/actions/generate-pdf.ts
action:

In Pass 1, for each type: "photo" field: read formData.__photoAssignmentsByField?.[field.id] first. If array non-empty, resolve each URL against job.photos[].url (then filename match as today) and record claim set. Else fall back to legacy scalar read (unchanged).
Also accumulate formData.summary_items?.flatMap(i => i.photos) ?? [] into the claim set.
In Pass 2, skip any field whose id is in the map's keys. Existing hasAnyResolvableExplicit gate unchanged.
In Q108 drain, subtract the full claim set (map + legacy scalars + summary photos) from job.photos.
verify: Unit-level: table-driven tests in src/__tests__/actions/generate-pdf.test.ts covering (a) legacy single-slot jobs untouched, (b) new multi-photo job with 2 photos on Q25, (c) Q108 drain subtracts map + summary, (d) Pass 2 doesn't backfill multi-photo fields.
done: All four resolver scenarios pass; legacy fixture byte-compares identical PDF bytes (or at minimum identical photo-placement metadata).
Task 3 — Server-side cap + eligibility enforcement
files: the existing admin photo-assignment server action (located next to admin-settings.tsx, not src/lib/actions/photos.ts)
action:

Add validation: when the payload writes an array, require fieldId ∈ ELIGIBLE_MULTI_PHOTO_FIELDS and urls.length ≤ MAX_PHOTOS_PER_FIELD. Reject with user-visible error otherwise.
Extend saveFormData similarly: if incoming __photoAssignmentsByField contains a field outside the eligible set or any array > 4, reject.
Same for summary_items: reject if items.length > MAX_SUMMARY_ITEMS or total photos > MAX_SUMMARY_PHOTOS_TOTAL.
verify: Add action-level tests: cap violation returns error; eligible + within-cap succeeds; ineligible field id rejected.
done: No path writes past the caps or to a non-eligible multi field.
Task 4 — JobForm multi-photo card
files: pool-app/src/components/job-form.tsx
action:

In FieldRenderer case "photo", branch on ELIGIBLE_MULTI_PHOTO_FIELDS.includes(field.id).
Eligible branch: Controller reads/writes formData.__photoAssignmentsByField[field.id]. Render thumbnails of currently-assigned URLs (resolve via job.photos passed in as prop — thread through from page.tsx), "+ Add" drawer listing unclaimed photos + "Take new" (reuses existing upload flow, then appends new URL), per-thumb remove, up/down reorder chevrons, "N of 4" counter, add disabled at cap.
Non-eligible branch: current code unchanged.
verify: Manual iPad flow on Q5: add 2 photos, reorder, remove one, add 2 more to hit cap, confirm Add is disabled.
done: Five eligible fields support add/remove/reorder up to 4; all other photo fields visually unchanged.
Task 5 — Admin photo-assignment UI extension
files: the existing admin photo-assignment component (find via grep for the server action from commit c7fe0eb — don't modify the server action here, only the UI unless Task 3 already covered its validation branch)
action:

For each eligible field, render a multi-select (checkboxes next to each photo thumbnail) capped at 4; disable further selection at cap.
For non-eligible photo fields, keep the existing single-pick UX.
Submit writes formData.__photoAssignmentsByField[fieldId] = [...urls] for eligible fields.
verify: Manual: reopen a draft with 6 pool photos, assign 3 to Q16, 4 to Q40, 1 to Q32 (single-slot), confirm PDF places them correctly.
done: Admin can bulk-assign up to 4 to any eligible field; single-slot fields unchanged.
Task 6 — Summary editor component + JobForm wiring
files: pool-app/src/components/summary-editor.tsx (new), pool-app/src/components/job-form.tsx
action:

New client component: list of items, each a textarea + photo thumbnails + per-thumb remove + "+ Photo" drawer. Add Item / Remove Item / Reorder (up/down). Emit SummaryItem[] via Controller-style prop. Enforce caps with soft-warn toast and hard-stop disable.
In JobForm, render SummaryEditor in place of the current summary text field. Bind to formData.summary_items. Keep formData.summary untouched on the write path so legacy data stays legible if a user re-opens an old draft (adapter handles the read side).
verify: Add 2 items with photos, reorder, remove one, autosave works, draft restore from localStorage round-trips.
done: Structured summary editable on iPad; caps enforced in UI.
Task 7 — PDF rendering for multi-photo + structured summary
files: pool-app/src/lib/actions/generate-pdf.ts
action:

Multi-photo grid renderer: 1/2/3/ photos single-row; 4 photos 2×2. Pre-measure full (label + grid) block and page-break atomically. Use existing fitPhoto.
Structured summary section: if adapter yields items, render each as { item-index. text } followed by that item's photo grid (same 1/2/3/4 layout). Legacy fallback renders the text blob unchanged. Place summary section where the current summary field sits — do not move the signature block.
verify: PDF golden-file compare for (a) legacy job → identical output, (b) new multi-photo + 3 summary items → manual visual pass on iPad Safari and Preview.app.
done: 1–4 photo layouts render correctly, summary items render, legacy unchanged, no signature/header regression.
Task 8 — Email HTML for structured summary
files: pool-app/src/lib/email.ts
action:

Replace the single summary cell with a per-item block: ordinal, item text, inline <img> thumbnails (Vercel Blob URLs — no base64) using the same 150px-square style as the existing photo gallery section.
Legacy adapter on read side: if summary_items absent but summary present, render as one item with no photos.
Numbered-question rows remain unchanged — they stay one row per field; if a multi-photo field has entries, render "(N photos attached)" in the value cell so the email is scannable without the PDF.
verify: Local react-email dev preview; send a test via Resend to staging inbox; confirm total payload under 40MB when PDF is attached at the ceiling case.
done: Office reviewer sees structured summary inline; legacy jobs render as before.
Task 9 — Verification + tests
files: pool-app/src/__tests__/actions/generate-pdf.test.ts, pool-app/src/__tests__/components/summary-editor.test.tsx, pool-app/src/__tests__/components/job-form.test.tsx
action:

Resolver table tests (already added in Task 2 — extend with summary + Q108 cases).
SummaryEditor: add/remove/reorder, soft-warn at 8 items, hard-stop at 15, hard-stop at 30 photos.
JobForm multi-photo card: add/remove/reorder, cap of 4.
Regression fixtures: 3 legacy submitted jobs (one with every field filled, one blank, one with Q108 leftovers) render byte-equivalent PDFs.
verify: npm test green; manual iPad Safari run on a fresh job through end-to-end submit.
done: Full suite green, regression fixtures identical, manual flow works.
Execution order + proposed commit messages
feat(forms): add multi-photo + summary_items types and caps
feat(pdf): extend 3-pass resolver for per-field arrays and summary claims
feat(server): enforce multi-photo cap and summary caps server-side
feat(job-form): per-field multi-photo card for Q5/Q16/Q25/Q40/Q71
feat(admin): multi-select photo assignment for eligible fields
feat(summary): structured SummaryEditor component and form wiring
feat(pdf): multi-photo grid + structured summary rendering
feat(email): per-item summary block with inline thumbnails
test: regression fixtures + multi-photo + summary coverage
Proof plan
Backward compat: 3 legacy submitted-job fixtures (captured before merge) produce byte-equivalent PDFs and visually-equivalent emails after merge.
Resolver correctness: Unit tests cover Pass 1 map hit, Pass 1 legacy fallback, Pass 2 skip on multi-photo field, Pass 2 fire on legacy field, Q108 drain subtracts map + legacy + summary.
Cap enforcement: Server action tests reject urls.length = 5 on Q5, reject assignment to non-eligible field, reject summary_items.length = 16, reject total summary photos = 31.
End-to-end: Manual iPad Safari — create draft, add 4 photos to Q25, add 2 summary items with photos, submit, open PDF on iPad, verify 2×2 grid on Q25 and per-item summary rendering. Check Resend payload size in dashboard ≤ 40MB.
Ownership invariant: Create job with 10 photos; assign 4 to Q5, 2 to Q16, 3 to summary item 1; verify PDF shows Q5=4, Q16=2, summary=3, Q108=1 (10 − 9).
Blockers / risks
Admin photo-assignment component location unverified: Task 5 assumes a single component. If the UI lives in multiple files, split into Tasks 5a/5b.
react-hook-form + reserved keys: RHF's field registration expects flat keys. __photoAssignmentsByField must be written via setValue / Controller, not registered. If buildFormSchema or getDefaultValues leak the reserved key into the Zod shape, validation will reject multi-photo writes — Task 1 must explicitly exclude reserved keys.
Vercel Fn timeout at ceiling: 65 photos × ~50ms embed ≈ 3.3s — fine, but PDF generation already does work. If the ceiling case approaches 10s, move generateJobPdf to a longer-runtime route or pre-compress further. Not expected to bite for typical jobs (~10–20 photos).
jsPDF memory at 65 images: ~35MB of JPEG in memory during doc construction. Serverless Fn default RAM (1024MB) is enough, but worth watching logs after the first real ceiling-case submission.
Data-integrity check in submit.ts (line 70): the 50%-missing-keys gate counts template field ids against formData keys. Adding __photoAssignmentsByField and summary_items does not affect the count (those are reserved, not template ids). Verify in Task 3 tests.
PhotoMetadata.uploadedAt ordering for Pass 2: Current job.photos push order is upload order, which is the deterministic tiebreaker Pass 2 uses. Don't change the write path in savePhotoMetadata (src/lib/actions/photos.ts is off-limits anyway).

