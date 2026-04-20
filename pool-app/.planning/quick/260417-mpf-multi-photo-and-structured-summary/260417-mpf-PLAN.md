---
id: 260417-mpf
title: Multi-photo numbered questions + structured summary — FINAL
date: 2026-04-17
status: approved_for_implementation
tasks: 12
supersedes: [260417-mpx, 260417-mpy, 260417-mpz, 260417-mp3]
base: 260417-mpy
---

# Quick Task 260417-mpf — Authoritative Plan

**Base:** 260417-mpy. **Diff vs mpy:** (1) autosave-preserve elevated to a top-level non-negotiable requirement with its own task, (2) new email surface check as an explicit scoping gate before any email.ts work, (3) new dedicated regression/acceptance test task at the end with five named proofs, (4) reserved key names locked and renamed `summary_items` → `__summary_items` for `__`-prefix consistency.

**Not imported:** mpz's smaller summary cap policy (kept mpy's 25 soft / 40 hard), mpx's legacy summary visual change (kept legacy text-blob render byte-equivalent), any variant that omits autosave-preserve.

---

## Goal (execution order)

1. Expand five numbered photo questions (Q5, Q16, Q25, Q40, Q71) from single-slot to up-to-4-photo slots, without touching the other ~20 photo fields.
2. Replace the one-blob "107. Summary" textarea with a structured list of items, each holding text and its own attached photos.
3. Keep the 3-pass photo resolver and Q108 drain intact; extend, do not rewrite. Legacy submitted jobs must still render identically.

**Rules:** no schema migration, no refactors outside the two goals, reserved `__`-prefixed keys for new structured data, one photo → exactly one owner, capacity policy is numeric not vibes, autosave never clobbers reserved keys.

**Prior stubs:** `260417-mp3` (empty), `260417-mpx` (sub-agent draft), `260417-mpy` (strongest base, chosen), `260417-mpz` (GPT-generated alt). This plan (mpf) is the single source of truth for implementation.

---

## Non-negotiable requirements (elevated from mpy Blockers)

### Reserved keys — LOCKED

These are the exact, final, authoritative reserved key names. Every reference in code, tests, helpers, and docs MUST use these spellings verbatim. No aliases, no shortcuts, no variants.

| Purpose | Reserved key (final, locked) | Type | Written by |
|---|---|---|---|
| Multi-photo slot map for Q5/Q16/Q25/Q40/Q71 | `__photoAssignmentsByField` | `Record<string, string[]>` | `assignMultiFieldPhotos`, `savePhotoAssignments` |
| Structured summary items (replaces legacy `formData["107_summary"]` blob) | `__summary_items` | `{ text: string; photos: string[] }[]` | `saveSummaryItems` |
| Reviewed sentinel (existing, shipped; reused unchanged) | `__photoAssignmentsReviewed` | `boolean` | `assignMultiFieldPhotos`, `savePhotoAssignments` |

**Constants in code must match exactly:**
```ts
export const RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField";
export const RESERVED_SUMMARY_KEY   = "__summary_items";
export const REVIEWED_FLAG          = "__photoAssignmentsReviewed";
```

Legacy key `formData["107_summary"]` (the original textarea blob) is NOT a reserved key — it's a user-editable template field id. It stays writable by autosave under its own name, and is preserved when a user migrates to structured items (never auto-deleted).

### AUTOSAVE-PRESERVE (critical)

`saveFormData` (the form's field-level autosave writer) MUST NOT clobber any of the three reserved keys listed above, nor any other `__`-prefixed reserved key introduced by a future dedicated action.

**Implementation rule — merge FRESH DB state, NEVER client-only RHF state:**

1. On every autosave call, re-read `job.formData` from the database. This must be a fresh `db.job.findUnique` (or equivalent) at the top of the action — do NOT trust a cached copy, do NOT accept the reserved keys from the client, do NOT reconstruct state from a client-held snapshot.
2. Build the write payload as `{ ...freshDbFormData, ...cleanedRhfState }` where `cleanedRhfState` has `undefined` values filtered out.
3. Write the merged object.

Rules this enforces:
- A reserved key written by a dedicated action (`assignMultiFieldPhotos`, `saveSummaryItems`) between the last page load and this autosave → **survives** (fresh DB read picks it up).
- A reserved key that RHF doesn't know exists → **survives** (RHF state doesn't have it, so the spread can't overwrite it).
- An RHF field whose value changed → **written** (RHF state wins for keys it owns).
- An RHF field whose value is `undefined` → **no-op** (filtered before spread, can't delete a DB key by accident).

**Explicitly prohibited patterns:**
- Sending the RHF state as the full `formData` object (`data: { formData: rhfState }`). Deletes everything RHF doesn't know about, including every reserved key. This is the autosave-clobber bug.
- Using a client-held snapshot of `formData` instead of re-reading from the DB. A client snapshot captured on page load is stale the moment any dedicated action fires.
- Merging on the client before sending. Merge happens server-side, after the fresh DB read.

Wired in Task 2. Verified by Proof 5 in Task 12.

Rationale: The form's 2-second debounced autosave writes the full form object. Dedicated actions write reserved keys on a separate channel. If autosave merges against stale state (cached, client-held, or RHF-only), the last-writer-wins collision silently deletes reserved data — the most dangerous class of bug in this slice because the UI still appears to work and the damage only shows up in the PDF render.

---

## Background (current code, not history)

### FormData contract today
- `FormData = Record<string, string | boolean>` — `src/lib/forms.ts:52`. Already mildly violated: `savePhotoAssignments` writes `__photoAssignmentsReviewed = true` (boolean, fine) into the same bag. No user-editable template field id is prefixed with `__`, so the reserved-key convention is already established and collision-safe.
- `job.formData` stored as Prisma `Json?` — no schema help, no migration friction for additive keys.

### Photo fields today (single-slot)
- Template photo fields store a single URL string at `formData[fieldId]`. `PhotoFieldInput` (`src/components/job-form.tsx:225-321`) is a `Controller` around one `<input type="file">` whose `onChange` calls `rhf.onChange(url)` — strictly one-value-per-field.
- Zod schema for photo fields is `z.string()` (`src/lib/forms.ts:123-128`). Array values would fail validation.
- Admin assignment UI `src/components/photo-assignments.tsx` does one `<select>` per photo, inverts photo→field into field→url (first wins), and calls `savePhotoAssignments` which writes `next[fieldId] = url | ""` (`src/lib/actions/photo-assignments.ts:68-72`).
- The 3-pass resolver in `src/lib/actions/generate-pdf.ts:154-233` reads `formData[fieldId]` as a string (`typeof raw !== "string"`) in Pass 1. Pass 2 gated on `!reviewed && !hasAnyResolvableExplicit`. Pass 3 is Q108 drain.

### Five multi-photo targets (verified in `scripts/extraction-output.json`)
- `5_picture_of_pool_and_spa_if_applicable`
- `16_photo_of_pool_pump`
- `25_picture_of_cartridge`
- `40_picture_if_leak_is_present_at_chlorinator`
- `71_picture_of_leaks_on_valves_if_applicable`

All five are `type: "photo"`, `required: false`.

### Summary today
- `107_summary` is `type: "textarea"` (`scripts/extraction-output.json:1265-1268`). Stored as a single string at `formData["107_summary"]`. Rendered in the PDF through the non-photo branch (`generate-pdf.ts:433-471`), label+value, wrapped text.

### Photo storage + email wire
- `job.photos: PhotoMetadata[]` — `{ url, filename, size, uploadedAt }`. Identity is `url`.
- Email wire: **only the generated PDF is attached** — `submit.ts:141-189`. Photos travel embedded inside the PDF, not as separate attachments. So the 40 MB Resend ceiling reduces to "how big is the PDF."
- **Email HTML body: surface-check this in Task 11.** Whether `email.ts` needs any changes depends entirely on whether the current email body renders summary content inline (vs. just "see PDF attachment"). Do NOT pre-schedule email.ts work.

---

## Structured-storage decision — Option B with mirror (inherited from mpy)

**Option B:** `formData["__photoAssignmentsByField"] = { "5_...": [url1, url2, ...] }`, mirror first URL at `formData["5_..."]` for legacy read-compat.

Full rationale in mpy (preserved verbatim). Summary: Option B keeps the 20+ non-multi photo fields, the Zod `z.string()` schema, `PhotoFieldInput`, and all legacy single-string readers untouched. Option A's `string | string[]` union would force `typeof` branching into every photo-field reader.

### Concrete shape under Option B

```ts
formData["__photoAssignmentsByField"] = {
  "5_picture_of_pool_and_spa_if_applicable": [url1, url2, url3],
  "16_photo_of_pool_pump": [url1],
};
formData["5_picture_of_pool_and_spa_if_applicable"] = url1; // mirrored primary
formData["16_photo_of_pool_pump"]                    = url1;

formData["__summary_items"] = [
  { text: "Observed algae in shallow end", photos: [url7] },
  { text: "Chlorinator inlet loose",        photos: [url8, url9] },
];
// formData["107_summary"] left untouched (may hold legacy blob; adapter decides which to render).
```

### Resolver extension (Pass 1a)

New sub-pass **before** existing Pass 1: for each field in `MULTI_PHOTO_FIELD_IDS`, read `formData["__photoAssignmentsByField"][fieldId]`, resolve each URL against `job.photos`, record consumed indices in `consumedPhotoIdxs`, store resolved list in `multiFieldResolvedUrls`, and pin `fieldResolvedUrl[fieldId] = urls[0]` so Pass 1 treats the field as resolved and Pass 2 skips it.

Original Pass 1, Pass 2, Pass 3: **unchanged**.

Summary items also claim photos into `consumedPhotoIdxs` (Task 10) before Pass 2 runs, so Q108 drain excludes them.

---

## Summary capacity policy — real numbers (inherited from mpy)

**Soft warning: 25 photos total across all summary items.** Inline non-blocking chip.
**Hard stop: 40 photos total across all summary items.** Client-disabled save button + server-side reject.
**No per-item photo cap.** Workers choose distribution within the total budget.

Math: compressed photo ~250–500 KB, p95 ~800 KB. jsPDF FAST mode stores JPEGs ~verbatim. 40 summary photos × 400 KB = 16 MB of summary; plus a 20 MB heavy non-summary case = 36 MB PDF → 48 MB email after base64 → Resend will reject at >40 MB decoded — 40 is the ceiling that keeps heavy jobs deliverable with headroom.

---

## must_haves

**truths:**
- T1 — The five listed fields (Q5, Q16, Q25, Q40, Q71) accept up to 4 photos each. Every other photo field remains single-slot; no change in behavior or UI.
- T2 — Multi-photo storage lives at `formData["__photoAssignmentsByField"][fieldId]` as a `string[]`; `formData[fieldId]` mirrors the first URL for backward read-compat. No Prisma schema change.
- T3 — 3-pass resolver is extended, not rewritten. Pass 1a precedes Pass 1. Pass 2 gate (`!reviewed && !hasAnyResolvableExplicit`), Q108 drain, and the reviewed sentinel behave identically to today.
- T4 — Admin photo-assignment UI supports assigning up to 4 photos to one of the 5 eligible fields. Non-multi fields render a single-slot dropdown as today.
- T5 — `107_summary` is backed by a structured `formData["__summary_items"] = { text, photos: string[] }[]` when the user creates items. Existing jobs whose `formData["107_summary"]` holds a plain string render identically in the PDF (no forced migration, no visual change).
- T6 — Per-summary-item photos are claimed out of `job.photos` exactly once. Q108 leftover math subtracts summary-claimed URLs.
- T7 — Total summary photo count is capped at **40 server-side**; a soft warning appears at **25** in the UI.
- T8 — PDF pagination never orphans a multi-photo field label on one page from its images on the next, and never splits mid-photo. Same rule for summary items: item heading never separated from its first line of text.
- T9 — Existing single-photo jobs (pre-mpf) render byte-equivalently: no divider change, no header change, no signature change, same question numbering, same wording, legacy summary text blob rendered the same as today.
- **T10 — `saveFormData` (autosave) preserves `__photoAssignmentsByField`, `__summary_items`, `__photoAssignmentsReviewed`, and every `__`-prefixed key on write. It re-reads current DB `formData` on every call and merges cleaned RHF state on top. A full-object overwrite, client-snapshot merge, or RHF-only write is prohibited.**
- **T11 — Email HTML (`src/lib/email.ts`) is only modified if a surface check (Task 11) confirms the current email renders summary content inline. If it doesn't, email.ts is not touched and Task 11 produces only a short decision note.**

**artifacts:**
- A1 — `src/lib/multi-photo.ts` (new): `MULTI_PHOTO_FIELD_IDS: ReadonlySet<string>`, `MULTI_PHOTO_CAP = 4`, `RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField"`, `REVIEWED_FLAG = "__photoAssignmentsReviewed"`, helper `readFieldPhotoUrls(formData, fieldId): string[]`.
- A2 — `src/lib/summary.ts` (new): `SummaryItem = { text: string; photos: string[] }`, `RESERVED_SUMMARY_KEY = "__summary_items"`, `parseSummaryItems(formData): SummaryItem[] | null`, `SUMMARY_PHOTO_SOFT_LIMIT = 25`, `SUMMARY_PHOTO_HARD_LIMIT = 40`, `collectSummaryPhotoUrls(items)`, `countSummaryPhotos(items)`.
- A3 — Widen `FormData` in `src/lib/forms.ts` to `Record<string, unknown>`. Reserved `__` prefix documented (including `__summary_items`).
- **A4 — Harden `saveFormData` (wherever it lives — find via grep for its export) to re-read DB on every call and preserve unknown DB keys. This is the autosave-clobber fix.**
- A5 — New server action `assignMultiFieldPhotos(jobId, fieldId, urls[])` in `src/lib/actions/photo-assignments.ts` (same file as `savePhotoAssignments`). Enforces 4-cap, draft-only, ownership (urls must be in `job.photos`), mirrors `urls[0]` into `formData[fieldId]`, sets `__photoAssignmentsReviewed = true`.
- A6 — Extension to `savePhotoAssignments` payload contract to accept slot-targeted strings `${fieldId}#${1..4}` for the five multi fields. Existing single-slot fields unchanged.
- A7 — `src/components/multi-photo-field.tsx` (new): 4-slot grid input replacing `PhotoFieldInput` only for the 5 eligible fields.
- A8 — `src/components/job-form.tsx` FieldRenderer branch: if `field.id ∈ MULTI_PHOTO_FIELD_IDS` → `MultiPhotoFieldInput`; if `field.id === "107_summary"` → `SummaryItemsEditor`.
- A9 — `src/components/photo-assignments.tsx` slot selector extension.
- A10 — `src/components/summary-items-editor.tsx` (new): list of items, per-item textarea + photo picker, add / remove / reorder, soft-warning chip at ≥25, add disabled at ≥40.
- A11 — `src/lib/actions/summary.ts` (new): `saveSummaryItems(jobId, items[])` enforcing 40-photo hard cap + ownership check.
- A12 — `src/lib/actions/generate-pdf.ts`: Pass 1a, multi-photo grid render, summary-items grid render, extended `consumedPhotoIdxs` accounting. Q108 drain logic untouched structurally.
- **A13 — Test suite (new, dedicated task): `src/__tests__/regression/mpf-*.test.ts` covering the five proofs in Task 12.**
- **A14 — Email surface decision note: `.planning/quick/260417-mpf-multi-photo-and-structured-summary/EMAIL-DECISION.md` (output of Task 11; short, 1 page max).**

**key_links:**
- `src/lib/actions/generate-pdf.ts` — extend only
- `src/components/job-form.tsx` — branch FieldRenderer
- `src/components/photo-assignments.tsx` — extend select options for 5 fields
- `src/lib/actions/photo-assignments.ts` — add new action + extend save payload
- `src/lib/forms.ts` — widen FormData type
- `saveFormData` (autosave writer) — harden against unknown-key clobber; fresh-DB-merge required
- `src/lib/email.ts` — touch ONLY if Task 11 decides
- `prisma/schema.prisma` — **no migration** (Job.formData is already `Json?`)
- `src/lib/actions/photos.ts` — off-limits per brief

---

## Tasks

Tasks 1–10 are copied from mpy with the same files, actions, verify, and done criteria. Task 2 (new) is the autosave-preserve hardening. Task 11 (new) is the email surface check. Task 12 (new) is the dedicated regression/acceptance test suite.

### Task 1 — Shared constants + widened FormData type

**files:** `src/lib/multi-photo.ts` (new), `src/lib/summary.ts` (new), `src/lib/forms.ts`

**action:** Export `MULTI_PHOTO_FIELD_IDS`, `MULTI_PHOTO_CAP=4`, `RESERVED_PHOTO_MAP_KEY="__photoAssignmentsByField"`, `REVIEWED_FLAG="__photoAssignmentsReviewed"`, `readFieldPhotoUrls`, `SummaryItem`, `RESERVED_SUMMARY_KEY="__summary_items"`, `SUMMARY_PHOTO_SOFT_LIMIT=25`, `SUMMARY_PHOTO_HARD_LIMIT=40`, `parseSummaryItems`, `countSummaryPhotos`, `collectSummaryPhotoUrls`. Widen `FormData` to `Record<string, unknown>`. Audit all read sites and narrow with `typeof` where needed. Reserved-key reads go through the helpers only.

**verify:** `bunx tsc --noEmit` clean; constants match `scripts/extraction-output.json` ids verbatim; `readFieldPhotoUrls` legacy + new-shape cases return expected arrays; `parseSummaryItems` legacy returns `null`.

**done:** Helpers exported, type widened, zero behavior change in isolation.

---

### Task 2 — Autosave-preserve hardening (NEW, elevated from mpy blockers)

**files:** whatever file exports `saveFormData` (locate via `grep -rn "export .*saveFormData" src/`). Expected: `src/lib/actions/form.ts` or similar.

**action:**

- On every autosave call, re-read `job.formData` fresh from the DB. Do not trust any caller-supplied snapshot.
- Build the next `formData` as: `{ ...freshDbFormData, ...cleanedRhfState }` — unknown keys from DB survive.
- Filter `rhfState` to remove keys where the value is `undefined` before spreading (prevents accidental key deletion).
- Do the DB write.
- Guard by status via `updateMany({ where: { id, status: "DRAFT" } })` so a submitted job never gets its reserved keys touched.

**pseudocode:**
```ts
export async function saveFormData(jobId: string, rhfState: Record<string, unknown>) {
  // CRITICAL: fresh DB read every call. Do NOT accept client-held formData snapshots.
  const current = await db.job.findUnique({ where: { id: jobId } });
  if (!current || current.status !== "DRAFT") {
    return { success: false, error: "Job is no longer editable" };
  }

  // RHF state is the source of truth for template-field keys ONLY.
  // Reserved DB keys (__photoAssignmentsByField, __summary_items,
  // __photoAssignmentsReviewed, any other __-prefixed key) must survive.
  const cleanedRhf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rhfState)) {
    if (v !== undefined) cleanedRhf[k] = v;
  }

  const merged = {
    ...(current.formData as Record<string, unknown> | null ?? {}),
    ...cleanedRhf,
  };

  await db.job.updateMany({
    where: { id: jobId, status: "DRAFT" },
    data: { formData: merged as unknown as object },
  });
  return { success: true };
}
```

**verify:**
- Unit: seed a draft with `formData = { customer_name: "X", __photoAssignmentsByField: { "5_...": ["u1"] } }`. Call `saveFormData(jobId, { customer_name: "Y" })`. Reload job: `formData.customer_name === "Y"` AND `formData.__photoAssignmentsByField["5_..."]` deep-equals `["u1"]`.
- Unit: seed with `formData = { foo: "a", __summary_items: [{ text: "t", photos: [] }] }`. Call with `{ foo: "b" }`. Reload: both keys intact, `foo === "b"`.
- Unit: call with `{ foo: undefined }` — key `foo` is NOT deleted (undefined is filtered, DB retains its prior value).
- Unit: call on a SUBMITTED job → returns error, DB unchanged.
- Integration-style unit: after seeding the draft, call an action that writes a reserved key (simulate `assignMultiFieldPhotos`), then call `saveFormData` with only template-field keys. Reload: the reserved key written between the page load and the autosave is present — proves the fresh-DB-read path, not a stale client snapshot.

**done:**
- `saveFormData` never removes unknown DB keys.
- Fresh DB read on every call (no client-snapshot merge).
- Undefined RHF values don't accidentally delete DB state.
- Submitted jobs are immune.

---

### Task 3 — Server action for multi-photo field assignment

**files:** `src/lib/actions/photo-assignments.ts`

**action:** (same as mpy Task 2) Add `assignMultiFieldPhotos(jobId, fieldId, urls)` — validates eligibility, cap, draft-only, ownership; dedupes; steals URLs from other multi-field entries to preserve one-owner; writes map + mirror; sets `__photoAssignmentsReviewed = true`. Extend `savePhotoAssignments` to accept `${fieldId}#${n}` slot-targeted strings; non-multi targets unchanged.

**verify:** (same as mpy) round-trip assign / cap reject / unknown-url reject / submitted-job reject; slot-suffix payload parses correctly.

**done:** Both actions enforce cap server-side; one-owner preserved; legacy single-slot payloads byte-equivalent.

---

### Task 4 — Extend Pass 1 with multi-photo sub-pass (Pass 1a)

**files:** `src/lib/actions/generate-pdf.ts`

**action:** (same as mpy Task 3) Insert Pass 1a before the existing Pass 1 loop. For each `MULTI_PHOTO_FIELD_IDS` field, read `__photoAssignmentsByField[fieldId]`, resolve URLs against `job.photos`, add indices to `consumedPhotoIdxs`, store in `multiFieldResolvedUrls`, pin `fieldResolvedUrl[fieldId] = urls[0]`. Original passes unchanged.

**verify:** Legacy job → no-op, byte-equivalent. New-shape job with 3 photos in Q5 → consumed set correct, `multiFieldResolvedUrls["5_..."] = [u1,u2,u3]`, Pass 2 doesn't touch it.

**done:** Pass 1a only; existing passes literally unchanged; `consumedPhotoIdxs` accounting keeps Q108 drain correct.

---

### Task 5 — PDF render: multi-photo 2×2 grid

**files:** `src/lib/actions/generate-pdf.ts`

**action:** (same as mpy Task 4) In the photo branch, if `MULTI_PHOTO_FIELD_IDS.has(field.id)` and `multiFieldResolvedUrls.get(field.id).length > 1`, render a 2×2 grid via `renderMultiPhotoGrid` (new helper). Else fall through to single-photo render. Pre-measure whole block for pagination — no orphan label, no mid-photo split. 1×1 photo path untouched.

**verify:** 1/2/3/4 photo layouts render correctly. 4-photo grid at page bottom moves to next page atomically. Single 404 renders placeholder, neighbors OK.

**done:** Single-photo path unchanged; 2×2 block never splits; label always with first image.

---

### Task 6 — Per-field multi-photo upload UI

**files:** `src/components/multi-photo-field.tsx` (new), `src/components/job-form.tsx`

**action:** (same as mpy Task 5) 4-slot 2×2 grid component. Empty slot → upload flow → `assignMultiFieldPhotos`. Filled slot → remove / reorder via ↑↓ buttons. `router.refresh()` after server action. Does NOT use RHF for the array; RHF sees the mirrored primary only. FieldRenderer branches on `MULTI_PHOTO_FIELD_IDS` for the `case "photo":` path.

**verify:** iPad flow: add / reorder / remove / cap disable; non-multi photo fields unaffected; submitted jobs read-only.

**done:** Only 5 multi fields use the new component; server cap enforced; existing `PhotoFieldInput` path unchanged.

---

### Task 7 — Admin photo-assignment UI: slot selector

**files:** `src/components/photo-assignments.tsx`

**action:** (same as mpy Task 6) For each multi-photo field, expand the `<select>` to 4 slot options (`${fieldId}#${n}`). Non-multi fields unchanged. Initial assignment derivation reads `__photoAssignmentsByField`. Server normalizes slot gaps at save time.

**verify:** Multi-select dropdowns show 5 × 4 + non-multi + Q108 + Unassigned. Slot-2-only assignment normalizes to slot-1. 5th slot rejected by server.

**done:** `<select>` expansion only for multi fields; slot normalization server-side; map + mirror both updated.

---

### Task 8 — `saveSummaryItems` action

**files:** `src/lib/actions/summary.ts` (new), `src/lib/summary.ts` (extensions)

**action:** (same as mpy Task 7) `saveSummaryItems(jobId, items)` — draft-only; normalizes text + dedupes photos per item; enforces 40-photo hard cap total; ownership check against `job.photos`; writes `formData.__summary_items` OR deletes the key when items is empty. Does NOT touch `formData["107_summary"]` (legacy blob preserved).

**verify:** 40-under success; 41 rejected; unknown-URL rejected; empty items deletes key; `parseSummaryItems` round-trip clean.

**done:** Hard cap + ownership enforced; legacy blob untouched.

---

### Task 9 — Summary items editor UI

**files:** `src/components/summary-items-editor.tsx` (new), `src/components/job-form.tsx`

**action:** (same as mpy Task 8) List of items (textarea + per-item photo picker). Ownership across items + multi-field slots visualized. Add / remove / reorder. Soft-warn chip at ≥25, add disabled at ≥40. Autosave-debounced `saveSummaryItems`. Legacy blob shown as a "Migrate to items" button (user-initiated only). FieldRenderer replaces textarea render for `107_summary` only.

**verify:** autosave round-trip; reorder persists; caps visible; legacy blob migration optional; submitted jobs read-only.

**done:** Only `107_summary` renders the editor; caps wired; legacy blob viewable; migration not forced.

---

### Task 10 — PDF render: summary items + Q108 accounting

**files:** `src/lib/actions/generate-pdf.ts`

**action:** (same as mpy Task 9) Early-claim summary photos into `consumedPhotoIdxs` right after Pass 1a. In the non-photo loop, branch on `field.id === "107_summary" && summaryItems !== null` → `renderSummaryItems(doc, items)` (heading "107. Summary", per-item heading + text + 2×2 grid). Legacy blob path (when `parseSummaryItems` returns `null`) unchanged.

**verify:** Legacy blob byte-equivalent. 2-item / 10-photo / paginating cases render without orphans. Q108 excludes summary-claimed URLs.

**done:** Legacy path unchanged; items render; Q108 drain correct; no mid-photo breaks.

---

### Task 11 — Email surface check (NEW — scoping gate)

**files:** read-only inspection of `src/lib/email.ts` and `src/lib/actions/submit.ts`; produce decision note at `.planning/quick/260417-mpf-multi-photo-and-structured-summary/EMAIL-DECISION.md`.

**action:**

1. Grep `src/lib/email.ts` for any reference to `summary`, `107_summary`, `__summary_items`, or a rendered summary-text block in the HTML body.
2. Decision tree:
   - If the current email HTML body renders summary content inline (e.g. a `<p>{summary text}</p>` cell in the table) → email.ts needs a per-item block (ordinal, item text, inline `<img>` thumbnails at existing 150px style). Spec the change in EMAIL-DECISION.md and add a sub-task 11a to implement it.
   - If the current email HTML body does NOT render summary inline (e.g. just "See attached PDF for full details") → email.ts is NOT touched. Write a 3-line EMAIL-DECISION.md stating "no change required; PDF is the only summary surface."
3. Also grep for any reference to numbered-question photo counts in the email body (e.g. does it render `"Q16: <img>"` inline, or just count them). Same decision tree: only spec email changes if needed.

**verify:**
- EMAIL-DECISION.md exists and is ≤ 1 page.
- If decision is "no change," no code under `src/lib/email.ts` was modified in this task.
- If decision is "change needed," the spec in EMAIL-DECISION.md names exact file:line ranges to modify and Task 11a appears with its own verify + done criteria.

**done:**
- Email surface explicitly scoped.
- No email.ts code written without a green-light decision.
- If 11a is spawned, it lands before Task 12 runs.

---

### Task 12 — Regression / acceptance test suite (NEW, dedicated)

**files:** `src/__tests__/regression/mpf-*.test.ts` (multiple files, one per proof); fixtures under `src/__tests__/regression/fixtures/`.

**action:** Produce five named proofs. Each is a test (unit or end-to-end where feasible) that either passes green or produces a manual-verification checklist with explicit artifacts.

#### Proof 1 — Legacy PDF regression
- Fixture: 1 SUBMITTED legacy job with 1 photo per multi-field + 3 Q108 leftovers + a non-empty `formData["107_summary"]` text blob + no `__photoAssignmentsByField` and no `__summary_items`.
- Generate PDF under mpf code.
- Extract text layer via `pdftotext` (or equivalent) and compare to a stored golden `legacy-golden.txt` captured pre-mpf.
- Expected: byte-equivalent text layer. Photo placement confirmed by deterministic layout metadata snapshot (field → `{x, y, w, h}` tuples).
- Pass criteria: zero diff on text layer, zero diff on layout snapshot.

#### Proof 2 — Multi-photo field
- Fixture: draft job with `job.photos = [p1, p2, p3, p4, p5]` and `formData.__photoAssignmentsByField = { "5_...": [p1.url, p2.url, p3.url] }`.
- Generate PDF.
- Assertion: Q5 renders a 3-photo layout (row-major: p1 top-left, p2 top-right, p3 bottom-left). Other multi fields render nothing (no photos assigned). Q108 contains [p4, p5] in upload order. No photo appears twice.

#### Proof 3 — Summary item
- Fixture: draft with `formData.__summary_items = [{ text: "Algae noted", photos: [p1.url] }, { text: "Loose inlet", photos: [p2.url, p3.url] }]` and `job.photos = [p1, p2, p3, p4]`.
- Generate PDF.
- Assertion: "107. Summary" heading present. Item 1 heading + "Algae noted" + single photo p1. Item 2 heading + "Loose inlet" + 2-photo row (p2, p3). Q108 contains [p4] only. `formData["107_summary"]` blob NOT rendered (adapter returned items, not null).

#### Proof 4 — Ownership / Q108 invariant
- Fixture: draft with `job.photos = [p1..p10]`; multi-field Q5 = [p1, p2], Q16 = [p3]; summary item 1 = [p4, p5], item 2 = [p6]; `formData["40_..."] = p7.url` (legacy single-slot); `__photoAssignmentsReviewed = true`.
- Generate PDF.
- Assertion: Q5 = [p1,p2], Q16 = [p3], Q40 = [p7], summary item 1 = [p4,p5], item 2 = [p6], Q108 = [p8,p9,p10] in upload order. **Every URL appears in exactly one bucket.** No duplicates, no missing. (This is the explicit one-photo-one-owner proof.)

#### Proof 5 — Autosave-preservation (CRITICAL)
- Fixture: draft seeded with `formData = { customer_name: "Alice", __photoAssignmentsByField: { "5_...": ["u1","u2"] }, __summary_items: [{ text: "t", photos: ["u3"] }], __photoAssignmentsReviewed: true }`.
- Call `saveFormData(jobId, { customer_name: "Bob", pool_size: "30000" })`.
- Reload job.
- Assertion:
  - `formData.customer_name === "Bob"` (overwritten by RHF state — expected).
  - `formData.pool_size === "30000"` (new RHF key — expected).
  - `formData.__photoAssignmentsByField["5_..."]` deep-equals `["u1","u2"]` (**preserved** — this is the whole point).
  - `formData.__summary_items` deep-equals `[{ text: "t", photos: ["u3"] }]` (**preserved**).
  - `formData.__photoAssignmentsReviewed === true` (**preserved**).
- Second sub-test: call `saveFormData(jobId, { customer_name: undefined })`. Assert `customer_name` retains its prior value (`"Bob"`), confirming undefined is filtered, not written as a delete.
- Third sub-test: call `saveFormData` on a SUBMITTED job → returns error, DB unchanged (bit-for-bit).
- Fourth sub-test (fresh-DB-read proof): seed a draft, call a dedicated action to write `__photoAssignmentsByField` in the DB AFTER the initial page state was captured, then call `saveFormData` with ONLY template-field keys in `rhfState`. Reload: the reserved key written between the "page load" and the autosave must be present — this proves the fresh DB read, not a stale client snapshot.

**verify:**
- All five proofs pass.
- `bunx tsc --noEmit` clean.
- `bun run build` clean.
- Fixture files checked in under `src/__tests__/regression/fixtures/`.

**done:**
- Five proofs live in the repo and run in CI.
- Any future regression to autosave-preserve, ownership invariant, or legacy byte-equivalence is caught by a test, not by field reports.

---

## Execution order + commit messages

One atomic commit per task, in order:

1. `feat(260417-mpf): shared multi-photo + summary constants and widen FormData`
2. `fix(260417-mpf): autosave-preserve unknown DB keys in saveFormData` — **critical, lands before any reserved-key writer**
3. `feat(260417-mpf): assignMultiFieldPhotos action + slot-aware savePhotoAssignments`
4. `feat(260417-mpf): Pass 1a multi-photo resolver in generate-pdf`
5. `feat(260417-mpf): 2×2 grid PDF render for multi-photo fields`
6. `feat(260417-mpf): MultiPhotoFieldInput with 4-slot grid UI`
7. `feat(260417-mpf): slot selector in admin photo-assignment UI`
8. `feat(260417-mpf): saveSummaryItems action + helpers`
9. `feat(260417-mpf): SummaryItemsEditor with soft + hard photo caps`
10. `feat(260417-mpf): summary items PDF render + Q108 leftover accounting`
11. `chore(260417-mpf): email surface decision note` (+ `feat(260417-mpf): email inline summary block` if 11a applies)
12. `test(260417-mpf): regression suite — legacy + multi + summary + ownership + autosave-preserve`

Task 2 is scheduled second on purpose: the autosave-preserve fix must ship before any task writes reserved keys, otherwise a window of deployment exists where live autosaves could clobber the new data.

---

## Proof plan (post-execution, live)

1. `bunx tsc --noEmit` — clean.
2. `bun run build` — clean.
3. Run full test suite — Proofs 1–5 all green.
4. Manual iPad Safari flow:
   - Reopen an existing draft. Upload 3 photos to Q5 via the new grid. Upload 2 more to Q25. Create 2 summary items with 2 and 1 photos respectively. Wait for autosave. Close the browser. Reopen. Verify every photo is still bound to its correct slot and every summary item persists.
   - Edit a template-field value (e.g. customer_name). Verify autosave fires. Reopen job. Verify multi-field assignments and summary items are **still present** (this is the live version of Proof 5).
   - Submit. Verify email arrives. Open PDF: Q5 shows 3-photo row, Q25 shows 2-photo row, summary section renders per-item. Q108 contains only truly unassigned photos.
5. If Task 11 decided email.ts needs changes: send a test email via Resend to a staging inbox and visually confirm the summary block renders as specced.

---

## Blockers / risks

- **FormData type widening blast radius.** Widened to `Record<string, unknown>`. Audit done in Task 1. Known read sites already use `typeof` guards or zod schemas.
- **iPad Safari reorder UX.** `↑`/`↓` buttons (no DnD).
- **External URL edge case in multi-photo.** `__photoAssignmentsByField` entry that's an `http(s)://` URL not in `job.photos` → passes through verbatim (matches existing Pass 1 external-URL semantics).
- **Legacy `savePhotoAssignments` compat.** Bare `fieldId` target continues to work; `fieldId#N` is additive.
- **No Prisma migration.** `Job.formData` is `Json?`.
- **Autosave collision (MITIGATED in Task 2 + verified in Proof 5).** Not a blocker anymore — it's a shipped fix with a regression test.
- **Email surface unknown until Task 11.** Scope-blocking by design: don't write email code speculatively.
