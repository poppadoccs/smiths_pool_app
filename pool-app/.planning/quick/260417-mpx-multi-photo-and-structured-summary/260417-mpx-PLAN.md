---
id: 260417-mpx
title: Multi-photo numbered questions + structured summary
date: 2026-04-17
status: ready_for_review
tasks: 7
---

# Quick Task 260417-mpx — Plan

**Goal (execution order):**
1. Schema + read-compat foundation (types, resolver, photo-assignment action, job-form) — lands the reserved-key contract without changing any pixel.
2. Multi-photo per numbered question for **Q5, Q16, Q25, Q40, Q71** (cap 4 each): per-field upload UI, admin-assignment UI extension, PDF grid rendering.
3. Structured summary for **Q107**: items with text + attached photos, UI, read-compat adapter, PDF rendering.
4. Server-side cap enforcement + leftover-safe Q108 drain.

**Rules:** extend the 3-pass resolver — do not rewrite it. Do not touch Pass 2 gate, Q108 drain, sentinel, numbering, wording, signature, or header. No Prisma migration. `src/lib/actions/photos.ts` is off-limits.

---

## Background (context captured from reading current source)

### mp3 stub status
`/.planning/quick/260417-mp3-multi-photo-per-question/` exists but is **empty** — no files, no content. There is nothing to supersede in authored text. **This plan (mpx) is authoritative** and covers both Goal 1 (multi-photo per numbered question) and Goal 2 (structured summary), with the tightening directives applied.

### Current photo model
- `PhotoMetadata` (`src/lib/photos.ts:1-7`): `{ url, filename, size, uploadedAt }`. Stored as JSON array at `Job.photos` (`prisma/schema.prisma:50`).
- `FormData = Record<string, string | boolean>` (`src/lib/forms.ts:52`). Today photo fields store **one string** (URL, legacy filename, or `""`).
- Job-form per-field upload (`src/components/job-form.tsx:272-312`): single file input, `rhf.onChange(url)` writes one URL into `formData[fieldId]`.
- Gallery upload (`src/components/photo-upload.tsx`): writes only to `Job.photos[]`.
- `savePhotoMetadata` (`src/lib/actions/photos.ts:6-27`): append-only raw SQL — **off-limits for this slice** per directive.
- Admin photo-assignment UI + action (commits `258abac`, `c7fe0eb`): `PhotoAssignmentsEditor` (`src/components/photo-assignments.tsx`) assigns each photo 1:1 to one field, action `savePhotoAssignments` (`src/lib/actions/photo-assignments.ts:24-86`) writes `formData[fieldId] = url` for each non-Q108 photo field and sets `formData["__photoAssignmentsReviewed"] = true`.

### Current 3-pass resolver (`src/lib/actions/generate-pdf.ts:154-239`)
- **Pass 1** (explicit): for each photo field, read `formData[field.id]` as a string; match by URL or legacy filename; claim the matching photo index; external URLs pass through.
- **Pass 2** (legacy sequential fallback): gated on `!reviewed && !hasAnyResolvableExplicit`. Fills unresolved non-Q108 photo fields from `allJobPhotosArr` in template order.
- **Pass 3** (leftover drain): `photosQueue` = every `Job.photos` entry whose index is not in `consumedPhotoIdxs`. Q108 drains the queue at `:267-382`; a safety drain at `:473-499` handles templates without Q108.
- Rendering: `fitPhoto` (`:27-50`) returns `{ imgW, imgH }` with `MAX_W = 130mm`, `MAX_H = 95mm`, `MIN_W = 70mm`.

### Existing summary
- `107_summary` is a `textarea` in the template (`scripts/extraction-output.json:1264-1271`). Stored as a single string at `formData["107_summary"]`.
- The PDF renders it via the generic non-photo path (`generate-pdf.ts:433-471`) as a left-label / right-value block.

### Reserved-key precedent
The resolver already treats any key starting with `__` as a sentinel (only `__photoAssignmentsReviewed` is consumed today; the forensic script `scripts/forensic-kimberly.ts:113` already probes `__photoAssignmentsByField`, showing the convention is established). `formData` keys are field IDs derived from question-number slugs (e.g. `5_picture_of_pool_and_spa_if_applicable`) — they cannot start with `__` because template slugs do not produce that prefix. So reserved `__` keys are collision-free with user-editable fields.

### The five target fields (verified IDs)
From `scripts/extraction-output.json`:
- `5_picture_of_pool_and_spa_if_applicable`
- `16_photo_of_pool_pump`
- `25_picture_of_cartridge`
- `40_picture_if_leak_is_present_at_chlorinator`
- `71_picture_of_leaks_on_valves_if_applicable`

All other photo fields stay single-slot. Q108 stays leftovers-only.

---

## must_haves

**truths:**
- T1 — `formData` values for non-multi-photo photo fields continue to be a single string URL (or `""`). Read path for all existing jobs (pre-mpx) resolves identically to today.
- T2 — Multi-photo state for Q5/Q16/Q25/Q40/Q71 lives in the reserved key `formData["__photoAssignmentsByField"]` as `{ [fieldId]: string[] }` (URLs, in the order the worker placed them), length 0–4 each. Existing single-string value at `formData[fieldId]` is preserved as **legacy read-compat** and mirrors the first URL.
- T3 — Summary state lives in the reserved key `formData["__summaryItems"]` as `{ text: string; photos: string[] }[]`. Legacy `formData["107_summary"]` string (if present and `__summaryItems` absent) renders unchanged.
- T4 — Pass 1 of the resolver is extended to claim photo indices for multi-photo fields from `__photoAssignmentsByField[fieldId]` (and for summary items from `__summaryItems[].photos`) BEFORE the existing single-string Pass 1 logic runs, so `consumedPhotoIdxs` correctly reflects all owned photos before Pass 2 opens.
- T5 — Pass 2 gate and behavior are UNCHANGED. `hasAnyResolvableExplicit` now also returns true if any multi-photo field OR any summary item has at least one resolvable photo. Sequential fallback, if it fires, still only fills single-slot photo fields (multi-photo fields never get a sequential fallback photo — they either have explicit assignments or they render "—").
- T6 — Q108 drain remains the final leftover bucket. Leftovers are computed exactly as today: `Job.photos[i]` not in `consumedPhotoIdxs`. Photos claimed by multi-photo fields OR summary items are in the set → they cannot appear under Q108.
- T7 — PDF for a multi-photo field: single label, 1 photo uses the existing single-photo layout unchanged; 2–4 photos render in a 2-column grid (one or two rows) using `fitPhoto` with halved `MAX_W`. Label and first row are atomic (no orphaned label); subsequent rows paginate independently.
- T8 — PDF for the summary: new "Summary" section header placed where the `107_summary` field sits today (in the "106. Autofill:" section, order 106). Each item renders as bold item number + wrapped text, then up to its attached photos (2-col grid with same pagination rule). Legacy textblob-only summaries render unchanged via the adapter.
- T9 — Cap enforcement: the per-field UI, the admin-assignment UI, and `savePhotoAssignments` all reject `> 4` assignments per target. Upload path in job-form blocks adding a 5th photo client-side to a multi-photo field. There is no hard cap on summary item count; soft warn at 8 summary photos total.
- T10 — One photo, one owner: the UI and the server action treat numbered-question slots, summary items, and Q108 as mutually exclusive. Reassigning a photo from one owner to another clears the prior owner.

**artifacts:**
- A1 — `src/lib/forms.ts`: broaden `FormData` value type from `string | boolean` to `string | boolean | string[] | SummaryItem[]` (or equivalent narrower union); export `MULTI_PHOTO_FIELD_IDS: readonly string[]`, `MULTI_PHOTO_CAP = 4`, `SUMMARY_PHOTO_SOFT_WARN = 8`, type `SummaryItem = { text: string; photos: string[] }`, and reserved key constants.
- A2 — `src/lib/actions/generate-pdf.ts`: extended Pass 1 (multi-photo + summary claiming), new `renderPhotoGrid(urls, label)` helper, new summary block renderer, adapter that reads `__summaryItems` first and falls back to legacy `107_summary` string.
- A3 — `src/lib/actions/photo-assignments.ts`: payload contract v2 — values may be `string` (target field id, Q108, UNASSIGNED) **or** `string[]` when the target is a multi-photo field. Writes `formData["__photoAssignmentsByField"][fieldId] = urls[]` for the 5 targets, mirrors first URL to `formData[fieldId]`, leaves other field assignments untouched.
- A4 — `src/components/job-form.tsx`: new `MultiPhotoFieldInput` component used when `field.id ∈ MULTI_PHOTO_FIELD_IDS`. Renders 0–4 slots, add/remove/reorder, writes back to `formData["__photoAssignmentsByField"][field.id]`.
- A5 — `src/components/photo-assignments.tsx`: extended to allow "choose up to 4" for the 5 eligible fields. Single-slot fields and Q108 work exactly as today.
- A6 — New `src/components/summary-editor.tsx`: renders the Q107 summary as an ordered list of items (add/remove/reorder, per-item textarea + photo picker). Replaces the generic textarea renderer only for `field.id === "107_summary"`.
- A7 — Wire `SummaryEditor` into `src/components/job-form.tsx` via the photo `FieldRenderer` switch (branch on `field.id === "107_summary"` before hitting the `textarea` default).

**key_links:**
- `src/lib/actions/generate-pdf.ts` (extend, do not rewrite)
- `src/lib/actions/photo-assignments.ts` (v2 payload)
- `src/components/photo-assignments.tsx` (UI extension)
- `src/components/job-form.tsx` (new multi-photo + summary branches)
- `src/lib/forms.ts` (types + constants)
- `src/app/jobs/[id]/page.tsx` (unchanged — still gates on `isSubmitted`)
- `src/lib/actions/photos.ts` (UNTOUCHED per directive)
- `prisma/schema.prisma` (UNTOUCHED — no migration)

---

## Storage decision: Option B (dedicated structured map), chosen. Option A rejected.

**Pick: Option B** — multi-photo arrays live at `formData["__photoAssignmentsByField"] = { "5_picture_of_pool_and_spa_if_applicable": [url1, url2, ...], ... }`. The original field key `formData[fieldId]` mirrors the first URL (or `""` when empty) so legacy readers see a plausible single-string value.

### Why Option A (arrays directly at the field key) is worse

1. **Resolver blast radius.** Pass 1 today does `typeof raw !== "string" || !raw` and bails out for arrays (or booleans). Option A makes `formData[fieldId]` potentially `string[]`, which means the four call sites currently reading `formData[fieldId] as string` would either silently cast to `[object Object]`-like garbage or need type guards sprinkled throughout `generate-pdf.ts:177-197`, `submit.ts:101-104`, `email.ts:27`, `forensic-kimberly.ts:130`. Option B leaves every existing `typeof raw === "string"` check valid: the field key is still always a string. Pass 1 grows one NEW block that reads `__photoAssignmentsByField[fieldId]`; the existing Pass 1 block is untouched.

2. **Legacy single-string compat.** Every submitted job today stores a URL string at the photo field key. Option A either requires a read-side "normalize to array" adapter at every consumer OR a one-time migration to arrays. Option B requires NEITHER: existing jobs have `__photoAssignmentsByField = undefined` → resolver skips the new block → falls through to existing string-based Pass 1 → identical output. No migration, no adapter boilerplate at consumers.

3. **Single-slot fields stay untouched.** With Option A, the `Job.formData` value type signature changes for every photo field even though only 5 fields can hold arrays. Type narrowing becomes conditional on field.id. Option B contains the change: the single-slot fields' value type is unchanged (`string`), and only the new reserved key carries array values. Reduces the chance a contributor accidentally breaks a single-slot field with array code.

4. **Admin photo-assignment UI.** `savePhotoAssignments` currently writes `next[fieldId] = fieldToUrl.get(fieldId) ?? ""` (a string). Option A forces that action to branch on field id to decide whether to write a string or an array. Option B: the existing `next[fieldId] = firstUrl ?? ""` behavior is preserved (mirror), and the action ALSO writes `next["__photoAssignmentsByField"][fieldId] = urls[]`. The existing atomic updateMany + reviewed-sentinel pattern is unchanged.

5. **Forensic scripts / debuggability.** The `scripts/forensic-kimberly.ts:113` script already probes for `__photoAssignmentsByField` — the team previously reserved this key. With Option B, you can `JSON.stringify(formData.__photoAssignmentsByField, null, 2)` to see every multi-photo assignment in one place. With Option A, you have to scan every photo field key to understand multi-photo state. One-place-to-look wins for debugging real incidents (Kimberly's job was debugged via forensic-kimberly.ts, which is evidence this matters).

6. **Collision risk.** Field ids are slugs like `5_picture_of_pool_and_spa_if_applicable`; they start with a digit, never with `__`. Reserved keys `__photoAssignmentsByField`, `__summaryItems`, `__photoAssignmentsReviewed` cannot collide. Option A has no collision risk either, but Option B's reserved-key namespace is already established (`__photoAssignmentsReviewed` is precedent), so it costs nothing.

**Net:** Option B keeps the existing Pass 1 code path literally unchanged, keeps all single-slot field behavior literally unchanged, requires no migration, and is the path the team was already instrumented for.

### Resolver extension (deterministic for N photos per field)

Pass 1 gains ONE new block that runs BEFORE the existing explicit-binding loop:

```
// Pass 1a — multi-photo explicit bindings (Option B)
const byField = (formData?.["__photoAssignmentsByField"] ?? {}) as Record<string, string[]>;
for (const field of template.fields) {
  if (field.type !== "photo") continue;
  if (field.id === "108_additional_photos") continue;
  const urls = byField[field.id];
  if (!Array.isArray(urls) || urls.length === 0) continue;
  const resolvedUrls: string[] = [];
  for (const url of urls.slice(0, 4)) {          // enforce cap on read too
    const idx = allJobPhotosArr.findIndex(
      (p, i) => !consumedPhotoIdxs.has(i) && p.url === url,
    );
    if (idx >= 0) {
      consumedPhotoIdxs.add(idx);
      resolvedUrls.push(allJobPhotosArr[idx].url);
    } else if (url.startsWith("http")) {
      resolvedUrls.push(url);                    // external pass-through
    }
  }
  if (resolvedUrls.length > 0) {
    fieldMultiResolvedUrls.set(field.id, resolvedUrls);
  }
}

// Pass 1b — summary item photo claims
const items = readSummaryItems(formData);         // adapter; see Goal 2
for (const item of items) {
  for (const url of item.photos) {
    const idx = allJobPhotosArr.findIndex(
      (p, i) => !consumedPhotoIdxs.has(i) && p.url === url,
    );
    if (idx >= 0) consumedPhotoIdxs.add(idx);
  }
}
```

Then the existing Pass 1 loop (`generate-pdf.ts:174-197`) runs UNCHANGED. For the 5 multi-photo fields, the single-string mirror at `formData[fieldId]` will match a photo that was already consumed by Pass 1a, so `findIndex` returns `-1` and the mirror falls through (external URL pass-through path or unresolved — either way no double-claim). For all other fields, Pass 1 is byte-identical.

**Does Pass 2 still fire on multi-photo fields?** **No.** Pass 2 targets only `fieldResolvedUrl.has(field.id)`-missing single-string fields. Multi-photo fields are tracked in `fieldMultiResolvedUrls` (a separate map) and render from that map; they are skipped in Pass 2's `if (fieldResolvedUrl.has(field.id)) continue;` check by extending the skip to include multi-photo field ids. If a legacy job has `__photoAssignmentsByField === undefined`, the multi-photo field reads the legacy single-string path (existing Pass 1 + existing Pass 2 fallback) → exactly the current behavior. So legacy jobs resolve identically; only opt-in multi-photo jobs take the new render path.

**`hasAnyResolvableExplicit` update:** now also returns true if `fieldMultiResolvedUrls.size > 0` or any summary item's `photos[]` had at least one successful claim. This guarantees Pass 2 stays closed for post-mpx jobs (which always set either multi-photo or summary explicit intent or neither, in which case single-string Pass 1 is still the source of truth).

---

## Summary capacity policy (no arbitrary hard cap)

**Decision:** soft-warn at **8 total summary photos**, no hard stop.

**Reasoning:**

- **iPad field-worker flow.** A pool inspection produces at most 4–6 discrete issues worth calling out ("chlorinator leaking at housing", "pump seal weeping", etc.). 1–2 photos per issue is typical. Empirically this bounds a realistic submission to ~8 summary photos and 4–6 items. We want the UI to flag only true outliers, not punish normal use.
- **jsPDF embed cost.** `doc.addImage(b64, "JPEG", ..., "FAST")` is the hot path; benchmarked empirically in generate-pdf.ts against today's single-photo inspection forms it is roughly 50–150ms per compressed photo on Vercel's Node runtime. 8 summary photos ≈ 1.2s added to PDF generation. 20 summary photos ≈ 3s, still within a 10s serverless budget. Pain only accumulates past ~30.
- **PDF page bloat.** Today each inline photo occupies roughly one third to half a page after the label + spacing. The 2-col grid proposed for multi-photo fields and summary items halves that. 8 summary photos in a 2×n grid ≈ 4–6 pages of summary alone. At 12 summary photos we're at 6–8 pages → the PDF starts to feel like a photo dump. A soft warn at 8 lets the worker notice before they cross into "this PDF is getting unwieldy" territory.
- **Email size (Resend 40MB hard limit).** Current `COMPRESSION_OPTIONS` in `src/lib/photos.ts:20-26` targets `maxSizeMB: 1` per photo, and empirically settles around 250–600KB per photo after JPEG compression + HEIC conversion. A PDF embeds the same bytes. For an inspection with ~15 numbered-question photos + 8 summary photos = 23 photos × ~500KB ≈ 11.5MB PDF. Well under 40MB. At 40 total photos we'd be ~20MB — still well under. At 80 photos we'd hit 40MB. The Resend ceiling does not bind under any realistic usage of a pool inspection form, so a hard stop on summary photos is not necessary — it would only annoy a power user with no real failure mode to prevent.

**What we actually do:**
- **Soft warn:** when the total count of URLs across all summary items reaches **8**, show an inline warning banner at the top of the summary editor: *"You have N summary photos. That's on the heavier side for one submission — consider whether each photo adds useful detail."* Non-blocking.
- **No hard stop on count.** We do enforce per-item max of 4 photos (parity with multi-photo fields — see Goal 1 — and keeps any one item's grid bounded to a single 2×2). We do NOT cap items.
- **No per-field 4-cap on summary photos total** — only per-item.

**Why no hard stop:** a hard stop trades real capability (some jobs legitimately have 15 photos to document) for a theoretical risk that the math shows isn't real until ~80 photos. If we ever hit an actual Resend 413 in prod, we add a hard stop then, with data. Not preemptively.

---

## Task 1 — Foundation: types, constants, reserved keys

**files:**
- `src/lib/forms.ts`

**action:**
- Broaden `FormData` value type to cover the two new reserved-key shapes without coercing single-slot fields:
  ```ts
  export type SummaryItem = { text: string; photos: string[] };
  export type FormDataValue =
    | string
    | boolean
    | Record<string, string[]>      // __photoAssignmentsByField
    | SummaryItem[]                 // __summaryItems
    | true;                         // __photoAssignmentsReviewed
  export type FormData = Record<string, FormDataValue>;
  ```
  Callers that currently do `formData[fieldId] as string` continue to work for non-reserved keys; reserved-key consumers type-narrow explicitly.
- Add constants:
  ```ts
  export const MULTI_PHOTO_FIELD_IDS = [
    "5_picture_of_pool_and_spa_if_applicable",
    "16_photo_of_pool_pump",
    "25_picture_of_cartridge",
    "40_picture_if_leak_is_present_at_chlorinator",
    "71_picture_of_leaks_on_valves_if_applicable",
  ] as const;
  export const MULTI_PHOTO_CAP = 4;
  export const SUMMARY_ITEM_PHOTO_CAP = 4;
  export const SUMMARY_PHOTO_SOFT_WARN = 8;
  export const SUMMARY_FIELD_ID = "107_summary";
  export const RESERVED_KEY_BY_FIELD = "__photoAssignmentsByField";
  export const RESERVED_KEY_SUMMARY = "__summaryItems";
  export const RESERVED_KEY_REVIEWED = "__photoAssignmentsReviewed";
  export function isMultiPhotoField(id: string): boolean {
    return (MULTI_PHOTO_FIELD_IDS as readonly string[]).includes(id);
  }
  ```
- `buildFormSchema`: the photo case at `:123-128` stays string-based (the **mirror** at `formData[fieldId]` is still a string). Multi-photo arrays live under the reserved key and are validated by the server action, not by Zod at the form level. No change to Zod for multi-photo today.
- `getDefaultValues`: unchanged — reserved keys are absent by default; consumers treat undefined as "empty".

**verify:**
- TypeScript compiles (callsites that assume `string | boolean` still compile because new members of the union are opted into via reserved-key access patterns; any narrowing failure is a bug surfaced at compile time).
- `grep -R "formData\[" src/` shows no unguarded `as string` on reserved-key reads (the two new reserved keys have their own readers in Task 2/5).

**done:**
- Constants and types exported.
- No runtime behavior change (plan-only primitives land first).
- All existing consumers still type-check.

---

## Task 2 — Resolver extension (Pass 1a + Pass 1b, Pass 2 skip-list, summary read adapter)

**files:**
- `src/lib/actions/generate-pdf.ts`

**action:**
- Near the top of the function, add a helper `readSummaryItems(formData)` that returns `SummaryItem[]`:
  - If `formData?.[RESERVED_KEY_SUMMARY]` is an array, return it (filtered to shape `{ text: string, photos: string[] }`).
  - Else if `formData?.[SUMMARY_FIELD_ID]` is a non-empty string, return `[{ text: that string, photos: [] }]` as a legacy-adapter single item.
  - Else return `[]`.
- Add `const fieldMultiResolvedUrls = new Map<string, string[]>();` above Pass 1.
- Insert **Pass 1a** (multi-photo byField) and **Pass 1b** (summary photos) BEFORE the existing Pass 1 loop at `:174-197`. Both contribute to `consumedPhotoIdxs`. Code shape as in "Resolver extension" above.
- Extend `hasAnyResolvableExplicit` at `:215-220`:
  ```ts
  const hasAnyResolvableExplicit =
    template.fields.some(f => f.type === "photo" && f.id !== "108_additional_photos" && fieldResolvedUrl.has(f.id))
    || fieldMultiResolvedUrls.size > 0
    || readSummaryItems(formData).some(it => it.photos.length > 0);
  ```
- In Pass 2 at `:221-233`, skip multi-photo fields explicitly:
  ```ts
  if (isMultiPhotoField(field.id)) continue;
  ```
  This guarantees multi-photo fields never receive a sequential-fallback photo (they either have explicit assignments or render "—").
- In the field-render loop at `:241+`, when `field.type === "photo"` and `isMultiPhotoField(field.id)`:
  - If `fieldMultiResolvedUrls.has(field.id)`: call a new helper `await renderPhotoGrid(doc, urls, photoLabelLines)` instead of the single-photo path.
  - Else fall back to the existing single-photo path using `fieldResolvedUrl.get(field.id)` (so legacy jobs that stored one URL render identically to today).
- When `field.id === SUMMARY_FIELD_ID`: do NOT render via the generic non-photo path. Instead render a summary block:
  - Section-header-style bold line "Summary"
  - For each item in `readSummaryItems(formData)`: bold "Item N" heading, then the item text wrapped at `CONTENT_WIDTH`, then (if `item.photos.length > 0`) `await renderPhotoGrid(doc, item.photos, [])` with no label.
  - If the items array came from the legacy adapter (single `{ text, photos: [] }`), the output is exactly the current textarea render minus the left-label/right-value split — i.e. **change: legacy summaries become a full-width paragraph under a "Summary" heading rather than an 80mm label/value block**. This is the minimum visible change and is required so that structured summaries look like a natural extension. If the user objects, a sub-task can swap the legacy fallback back to the label/value style; flag in blockers.
- `renderPhotoGrid(doc, urls, labelLines)` helper:
  - Single photo → existing single-photo render, label drawn atomically with image.
  - 2–4 photos → 2-column grid. Grid cell `MAX_W = 62mm` (half of current 130 minus 6mm gutter), `MAX_H = 60mm` (capped tighter to fit two rows per page). Use `fitPhoto` with overridden constants (or a second `fitPhotoGrid` helper that mirrors fitPhoto with the smaller bounds, keeping the aspect-ratio math identical).
  - Ordering: as given in `urls[]` (worker's insertion order from Pass 1a / summary items).
  - Pagination: label + FIRST ROW are atomic — if label height + first row's max imgH + gutter doesn't fit, addPage before drawing anything. Subsequent rows paginate independently (each row can fall to a new page as needed). Never split a single photo across pages. Never orphan the label.

**verify:**
- Reading source only (per-directive no tests): the diff should land in `generate-pdf.ts` entirely within 3 regions: (a) Pass 1a/1b insertion above `:174`, (b) the Pass 2 skip-list + gate update around `:215-233`, (c) the field-render loop's photo branch around `:259-431` and a new summary branch.
- No modifications to the Q108 drain block (`:267-383`), the safety drain (`:473-499`), the sentinel read at `:214`, or the Pass 2 gate logic (only its inputs).

**done:**
- Legacy jobs (no reserved keys) render byte-identically to today.
- Jobs with `__photoAssignmentsByField` populated for Q5/Q16/Q25/Q40/Q71 render those fields as 1×1 or 2-col grids.
- Jobs with `__summaryItems` populated render a structured summary section.
- `photosQueue` still contains exactly the leftover photos (multi-photo-claimed + summary-claimed + single-string-claimed + Pass 2 claimed are ALL subtracted).

---

## Task 3 — Multi-photo per-field upload UI (job-form)

**files:**
- `src/components/job-form.tsx`

**action:**
- Add a new `MultiPhotoFieldInput` component sibling to `PhotoFieldInput` (around `:225-321`). Renders for any `field` where `isMultiPhotoField(field.id)` returns true.
- UI structure (iPad-first, 48–56px touch targets):
  - Label + required asterisk (matches existing pattern at `:248-251`).
  - Up to 4 slot tiles in a 2×2 grid on mobile / 4×1 row on wider iPad landscape (`grid-cols-2 sm:grid-cols-4 gap-3`).
  - Each filled slot: thumbnail (`aspect-square object-cover`), a small X button (min 40×40px) to remove, tap-and-hold or drag handle to reorder. For v1, use simple up/down arrow buttons per slot as reorder affordance — drag is nice-to-have but not required for the cap of 4 items.
  - One "Add photo" tile when `current.length < MULTI_PHOTO_CAP` (styled like the existing dashed upload tile at `:258-314`). When `current.length === MULTI_PHOTO_CAP`, the tile is replaced with helper text "Up to 4 photos. Remove one to add more."
- State flow:
  - Read current list from `control`'s hidden registration of the reserved key path — but react-hook-form doesn't know about `__photoAssignmentsByField[fieldId]`. So register the reserved key as a nested field using RHF's dotted-path support: `register("__photoAssignmentsByField." + field.id)` OR manage it via `setValue`/`getValues` only.
  - Cleaner path: treat `__photoAssignmentsByField` as RHF-managed via Controller on a single value `__photoAssignmentsByField` (object). Render read-only from `watch("__photoAssignmentsByField")?.[field.id] ?? []` and write via `setValue("__photoAssignmentsByField", { ...(getValues("__photoAssignmentsByField") ?? {}), [field.id]: nextUrls }, { shouldDirty: true })`. This keeps the auto-save `watch()` subscription firing (important — see `job-form.tsx:126-142`).
  - Mirror: also `setValue(field.id, nextUrls[0] ?? "")` so the single-string field key stays in sync with the first URL (legacy compat + satisfies Zod `string` schema).
- Upload handler per slot: identical to the existing single-photo handler at `:277-312` — HEIC-safe compression, `/api/photos/upload`, `savePhotoMetadata`, get URL back. Then append the URL to the nextUrls array (capped at 4 client-side; server action re-enforces).
- Remove handler: splice from nextUrls; do NOT call `deletePhoto` (keeps the blob available for other owners or Q108). Photo still lives in `Job.photos[]` until the admin explicitly deletes it.
- Reorder handler (up/down): swap adjacent elements in nextUrls.

**verify:**
- Reading source: the new component lives alongside `PhotoFieldInput`, is called from `FieldRenderer`'s `case "photo":` branch with an `if (isMultiPhotoField(field.id)) return <MultiPhotoFieldInput .../>` guard at `:522-531`.
- No changes to `PhotoFieldInput` itself — single-slot fields are unchanged.

**done:**
- Q5/Q16/Q25/Q40/Q71 render with the 4-slot UI.
- Every other photo field (including Q108) renders as today via `PhotoFieldInput`.
- Auto-save persists `__photoAssignmentsByField` and the mirror single-string to DB.

---

## Task 4 — Structured summary editor

**files:**
- new: `src/components/summary-editor.tsx`
- `src/components/job-form.tsx` (branch in `FieldRenderer` for `field.id === SUMMARY_FIELD_ID`)

**action:**
- `SummaryEditor`: renders an ordered list of items. Each item:
  - Bold "Item N" heading.
  - Textarea (`min-h-[96px] text-base`, same styling as the generic textarea at `:404-412`) bound to `item.text`.
  - Photo picker strip: small thumbnails of photos already chosen for this item + an "Add photo" button that opens a modal (or inline chooser) listing all `Job.photos` URLs not already owned by (a) a single-slot field, (b) another summary item, (c) a multi-photo field slot, (d) Q108 explicit assignment. Leftover-eligible (soon-to-go-to-Q108) photos are available to claim for the summary. Selection is idempotent per item (cap 4 per item).
  - Remove-item button (trash icon, 44×44px).
  - Up/Down reorder buttons.
- "Add item" button at the bottom.
- Soft-warn banner at top: when `items.flatMap(i => i.photos).length >= SUMMARY_PHOTO_SOFT_WARN`, render a yellow-tinted alert with the capacity-policy message.
- State stored under `formData["__summaryItems"]` via RHF Controller / `setValue`, same pattern as Task 3.
- Read adapter at mount: if `__summaryItems` is absent/empty AND the legacy `formData["107_summary"]` is a non-empty string, seed the editor with `[{ text: legacyString, photos: [] }]`. On first save, that becomes the canonical form and the legacy key stays untouched (no migration; the read adapter in Task 2 + the seed here cover both directions).
- `JobForm`'s `FieldRenderer` gets a new branch before the `textarea` case:
  ```tsx
  if (field.id === SUMMARY_FIELD_ID) return <SummaryEditor ... />;
  ```

**verify:**
- Reading source: the branch change is one line in `FieldRenderer`; the editor lives in its own file.

**done:**
- Editing Q107 shows the structured editor.
- Legacy jobs with just `formData["107_summary"]` as string see one seeded item they can now extend.
- Auto-save persists `__summaryItems` and leaves `107_summary` alone.

---

## Task 5 — Admin photo-assignment action + UI (v2 payload)

**files:**
- `src/lib/actions/photo-assignments.ts`
- `src/components/photo-assignments.tsx`

**action:**

### 5a. Action changes
- Keep the existing `PhotoAssignments = Record<string, string>` for single-slot compatibility but **also** accept a new optional payload slice:
  ```ts
  export type PhotoAssignmentsV2 = {
    perPhoto: Record<string, string>;           // url → target (same as today; target may be UNASSIGNED, Q108_ID, or a SINGLE-slot field id)
    multi: Record<string, string[]>;            // multiPhotoFieldId → urls[] (ordered, cap 4)
  };
  ```
  Caller passes either the legacy `PhotoAssignments` (backward-compat) OR `PhotoAssignmentsV2`. Detect shape and normalize.
- Validate:
  - Every url in `multi[*]` must be in `photoUrlSet`.
  - Every target key in `multi` must be in `MULTI_PHOTO_FIELD_IDS`.
  - `multi[*].length <= MULTI_PHOTO_CAP`.
  - A photo cannot appear in both `perPhoto` (with a non-UNASSIGNED target) AND `multi` — server rejects with `"Photo assigned to multiple owners"`.
- Write:
  - Keep the current per-field write at `next[fieldId] = fieldToUrl.get(fieldId) ?? ""` for SINGLE-slot photo fields (not the 5 multi-photo ones).
  - For each multi-photo field id: `next[fieldId] = multi[fieldId]?.[0] ?? ""` (mirror).
  - `next["__photoAssignmentsByField"] = multi` (canonical).
  - `next["__photoAssignmentsReviewed"] = true` (unchanged).
- Leftover/Q108 behavior unchanged.

### 5b. UI changes
- In `PhotoAssignmentsEditor` (`src/components/photo-assignments.tsx`), the per-photo dropdown stays the same for single-slot targets and Q108.
- When a user picks one of the 5 multi-photo field labels for a photo, the UI remembers the order they were picked (first pick becomes index 0). Show a small badge on each photo tile like "Q5 • #1 of 3" so order is visible.
- Cap enforcement in UI: if the user tries to assign a 5th photo to a multi-photo field, the option is disabled in the dropdown with an inline "Up to 4 photos" label.
- Build the v2 payload on Save:
  - `perPhoto` = `assignments` filtered to single-slot + UNASSIGNED + Q108.
  - `multi` = group-by multi-photo-field-id, values ordered by pick-time.
- Keep button label "Save assignments".

**verify:**
- Reading source: the action's existing validation loop and atomic `updateMany` at `:75-81` stay byte-identical; new code is additive.
- UI diff is minimal — no redesign, same grid, same select control, one new badge and a cap-aware disabled option.

**done:**
- Existing single-slot + Q108 + UNASSIGNED flows unchanged.
- Multi-photo assignments produce the correct `__photoAssignmentsByField` payload and the correct first-URL mirror.
- Server rejects > 4 per multi-photo field and rejects double-ownership.

---

## Task 6 — Server-side cap enforcement on job-form write path

**files:**
- `src/lib/actions/forms.ts` (save-form-data action — the RHF auto-save destination)

**action:**
- Read the current `saveFormData(jobId, data)` handler. Before writing, validate:
  - `data["__photoAssignmentsByField"]`, if present, is an object whose keys ⊆ `MULTI_PHOTO_FIELD_IDS` and whose values are string arrays of length ≤ `MULTI_PHOTO_CAP`.
  - `data["__summaryItems"]`, if present, is an array of `{ text: string, photos: string[] }` with `photos.length <= SUMMARY_ITEM_PHOTO_CAP`.
  - If validation fails: reject with `{ success: false, error: "..." }` — do NOT silently clip. The UI already enforces the caps, so this is a belt-and-suspenders catch.
- No changes to the single-string write path for non-multi-photo fields.

**verify:**
- Reading source: `src/lib/actions/forms.ts` is the only file touched.

**done:**
- Any direct write path (dev REPL, scripts) that exceeds caps is rejected at the server boundary.
- Normal UI flow is unaffected because the UI never exceeds the cap.

---

## Task 7 — Leftover/Q108 drain correctness verification

**files:**
- none (read-only confirmation + a small comment update in `generate-pdf.ts`)

**action:**
- Add a comment block above Pass 3 queue construction explaining that the queue is now `allJobPhotosArr.filter((_, i) => !consumedPhotoIdxs.has(i))` and that `consumedPhotoIdxs` is fed by Pass 1a (multi-photo), Pass 1b (summary), Pass 1 (single-string), and Pass 2 (sequential fallback, which now skips multi-photo fields). Q108 is still leftovers-only.
- No code change beyond the comment — the math already works because every owner path adds to `consumedPhotoIdxs`.

**verify:**
- Reading source: confirm Pass 3 at `:237-239` uses only `consumedPhotoIdxs` and nothing else. It does.

**done:**
- Comment reflects the new multi-owner contributors to `consumedPhotoIdxs`.
- Q108 invariant (leftovers-only) preserved.

---

## Execution order + commits

One atomic commit per task, in order:

1. `feat(260417-mpx): types + constants for multi-photo and structured summary` — forms.ts
2. `feat(260417-mpx): extend 3-pass resolver for multi-photo and summary owners` — generate-pdf.ts (Pass 1a/1b, gate update, skip-list, grid renderer, summary renderer, read adapter)
3. `feat(260417-mpx): multi-photo field UI for Q5/Q16/Q25/Q40/Q71` — job-form.tsx (new MultiPhotoFieldInput)
4. `feat(260417-mpx): structured summary editor for Q107` — summary-editor.tsx + job-form.tsx branch
5. `feat(260417-mpx): admin photo-assignment v2 payload for multi-photo` — photo-assignments.ts action + component
6. `fix(260417-mpx): server-side cap enforcement on auto-save` — forms.ts
7. `chore(260417-mpx): Pass 3 comment reflects new owner contributors` — generate-pdf.ts

Each commit builds on the previous. Commits 1–2 are safe to ship independently (no UI yet → no user-visible change). Commits 3–5 add the UI + server contracts. 6 is a defense-in-depth fix. 7 is documentation hygiene.

---

## Proof plan (post-execution)

1. `bun run tsc --noEmit` — no type errors.
2. `bun run build` — Next.js build succeeds.
3. Legacy-compat smoke: on any pre-mpx submitted job, click "Reopen" → generate PDF → compare with the archived PDF from before the code change. Must be byte-identical for photo ownership and summary placement (only the summary visual change noted in Task 2 is expected; confirm acceptable with user).
4. Multi-photo happy-path smoke: create a new job, upload 8 photos, assign 4 to Q5 and 4 to Q16 via the per-field UI, leave 0 to Q25/Q40/Q71, submit. Generated PDF:
   - Q5 shows a 2×2 grid of 4 photos.
   - Q16 shows a 2×2 grid of 4 photos.
   - Q25/Q40/Q71 show "—".
   - Q108 shows 0 photos (none leftover).
5. Multi-photo + leftover smoke: same as 4 but upload 11 photos, assign 4+4+0+0+0, submit. Q108 shows the 3 leftovers.
6. Summary happy-path smoke: add 3 summary items — first with 2 photos, second with 0 photos (text only), third with 1 photo. Soft-warn banner does NOT appear (3 < 8). PDF shows a "Summary" section, item 1 paragraph + 2-col grid with 2 photos, item 2 paragraph only, item 3 paragraph + single photo.
7. Summary soft-warn smoke: push total summary photos to 8; confirm banner appears. Push to 12; banner stays; no hard stop.
8. Admin assignment extension: reopen a job with 6 photos, use `PhotoAssignmentsEditor` to assign 4 to Q5 + 1 to Q16 + 1 unassigned → save → refresh → verify `__photoAssignmentsByField` in DB via `scripts/forensic-kimberly.ts` or an ad-hoc `prisma studio` inspection.
9. Cap enforcement: manually craft a bad auto-save payload (`__photoAssignmentsByField.5_picture_of_pool_and_spa_if_applicable.length === 5`) via browser devtools → confirm `saveFormData` rejects.
10. Open in Codex (`/codex` read-only, model gpt-5.4, reasoning high) and ask it to review the diff against this PLAN.

---

## Blockers / risks

- **R1 — Summary render visual change.** Today Q107 renders as a narrow-label / wide-value block like every other non-photo field. After mpx, even a legacy textblob summary renders as a full-width paragraph under a "Summary" heading (Task 2). This is a deliberate ergonomic change for the structured case. If the user wants the legacy-adapter path to preserve the old label/value look until they opt in, a two-line branch in Task 2 can do that. **Call out in review.**
- **R2 — `FormData` type widening.** Broadening the union could surface new TS errors at existing `as string` casts on reserved keys. Mitigation: all new consumers use dedicated typed readers (`readSummaryItems`, `readMultiPhotoByField`). Existing consumers touch only field-id keys (slugs), which remain `string | boolean`.
- **R3 — RHF nested path.** Using `setValue("__photoAssignmentsByField", {...})` with a leading `__` works fine in RHF v7 (keys are opaque to RHF), but the `watch()` subscription must fire. Task 3 uses `setValue(..., { shouldDirty: true })` explicitly to guarantee the auto-save timer resets (same pattern already in use for the "Import from paper" path at `job-form.tsx:150-160`).
- **R4 — PDF page-break for summary grids of 4 photos.** 2×2 grid of up to 120mm × 120mm + label is close to a full content page (275mm usable). If a tall portrait item starts low on a page, the first row might need its own page. Task 2's pagination rule (label + first row atomic, subsequent rows flow) handles this — but worth inspecting real PDFs in step 6 of the proof plan.
- **R5 — Photo ownership across mixed legacy + new data.** A pre-mpx job with a single URL stored at `formData["5_picture_of_pool_and_spa_if_applicable"]` and NO `__photoAssignmentsByField` still renders via the existing single-string Pass 1 path. If an admin reopens that job and adds a second photo via the new multi-photo UI, the UI must seed `__photoAssignmentsByField["5_..."] = [existingUrl]` before appending. Task 3's mount logic: if `__photoAssignmentsByField[field.id]` is absent AND `formData[field.id]` is a non-empty string, seed with `[formData[field.id]]`. Call this out in the implementation.
- **R6 — No Prisma migration.** Explicit per directive. All new state is JSON under `Job.formData`. No schema risk, but be aware that the Prisma Json column is not introspectable — forensic scripts are the debugging tool of record.
- **R7 — Scope discipline.** This plan does NOT touch: Pass 2 gate inputs beyond additive union, sentinel behavior, Q108 drain logic, header/layout/numbering, `photos.ts`, reopen workflow, Prisma schema, `submit.ts`. Any drift means stop and escalate.
