---
id: 260417-mpy
title: Multi-photo numbered questions + structured summary
date: 2026-04-17
status: ready_for_review
tasks: 9
---

# Quick Task 260417-mpy — Plan

**Goal (execution order):**
1. Expand five numbered photo questions (Q5, Q16, Q25, Q40, Q71) from single-slot to up-to-4-photo slots, without touching the other ~20 photo fields.
2. Replace the one-blob "107. Summary" textarea with a structured list of items, each holding text and its own attached photos.
3. Keep the 3-pass photo resolver and Q108 drain intact; extend, do not rewrite. Legacy submitted jobs must still render identically.

**Rules:** no schema migration, no refactors outside the two goals, reserved `__`-prefixed keys for new structured data, one photo → exactly one owner, capacity policy is numeric not vibes.

**Prior stub:** `.planning/quick/260417-mp3-multi-photo-per-question/` is empty (zero files). Choice: **SUPERSEDE**. This plan is the single source of truth for both Goal 1 and Goal 2.

---

## Background (current code, not history)

### FormData contract today
- `FormData = Record<string, string | boolean>` — `src/lib/forms.ts:52`. This is already mildly violated: `savePhotoAssignments` writes `__photoAssignmentsReviewed = true` (boolean, fine) into the same bag. No user-editable template field id is prefixed with `__`, so the reserved-key convention is already established and collision-safe.
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

All five are `type: "photo"`, `required: false`. They currently render via the same `PhotoFieldInput` as every other photo question.

### Summary today
- `107_summary` is `type: "textarea"` (`scripts/extraction-output.json:1265-1268`). Stored as a single string at `formData["107_summary"]`. Rendered in the PDF through the non-photo branch (`generate-pdf.ts:433-471`), label+value, wrapped text.

### Photo storage
- `job.photos: PhotoMetadata[]` — `{ url, filename, size, uploadedAt }`. Both form-bound uploads and gallery uploads append to this array via `savePhotoMetadata`. Identity is `url` (duplicate filenames tolerated).
- Email wire: only the generated PDF is attached — `submit.ts:141-189`. Photos travel embedded inside the PDF, not as separate attachments. So the 40 MB Resend ceiling reduces to "how big is the PDF."

---

## Structured-storage decision — **Option B wins**

Compared head-to-head:

| Concern | Option A: `formData["5_..."] = [url1, url2, ...]` | Option B: `formData["__photoAssignmentsByField"] = { "5_...": [url1, ...] }`, mirror first URL at `formData["5_..."]` |
|---|---|---|
| 3-pass Pass 1 | Must detect array vs string at every photo field; branch doubles. Legacy strings must remain readable — two parallel code paths. | Pass 1 unchanged for single-slot. For the 5 multi fields, read the reserved map first; absent → fall through to the legacy single-string path. One extra lookup, no branching on type. |
| Pass 2 (legacy sequential fallback) | Risks overwriting an already-populated array slot. Unclear ordering rules. | Multi fields fall into Pass 2 only via their mirrored primary `formData[fieldId]`. Identical single-slot behavior — Pass 2 remains unaware of the map. Legacy jobs (one photo per field) resolve identically. |
| Legacy single-string read-compat | Every reader (PDF generator, `PhotoAssignmentsEditor` initializer, forensic scripts) must `typeof v === "string"` check and handle both shapes. Broad blast radius. | Readers keep treating `formData[fieldId]` as a string. New multi-aware code reads the reserved map explicitly. Zero diff for the 20+ other photo fields. |
| Non-multi photo fields staying untouched | Possible but every read site needs a "this field is single-slot, don't expect array" comment — easy to forget. | Constant `MULTI_PHOTO_FIELD_IDS` is the only place the distinction lives. Touching a non-multi field is impossible without editing that set. |
| Admin photo-assignment UI | `savePhotoAssignments` needs per-field-type branching (string vs array writes) and a slot-indexed `<select>` payload schema. | Admin UI adds `fieldId#1`..`fieldId#4` target strings for the five multi fields only; the server inverts into arrays. Minimal diff — existing single-slot payloads unchanged. |
| `formData` readability (debugging, forensics) | Mixed-type bag: some fields are strings, some are arrays. Readers must type-check every time. | Primary photo still visible at `formData["5_..."]` (string). Extras live at a clearly-marked reserved key. Forensic scripts that only look at `formData[fieldId]` still see a sensible answer for every multi field. |
| Reserved-key collision risk | No reserved key used. | Zero — `__` prefix is already reserved (`__photoAssignmentsReviewed`). No user-editable field id starts with `__`. |
| Zod schema | Must widen photo-field schema to `z.union([z.string(), z.array(z.string())])`. rhf typing follows. | Photo-field schema stays `z.string()`. Structured data bypasses the per-field Zod shape entirely (already true for `__photoAssignmentsReviewed`). |

**Pick: Option B.** The decisive factors are (a) the legacy-single-string read-compat story — Option A forces `typeof` checks into every reader in the codebase — and (b) the touch-surface on `PhotoFieldInput` and Zod. Option A would either require a full rewrite of `PhotoFieldInput` to be array-aware (breaking the 20 non-multi photo fields) or per-field-id branching at the component level (which is what Option B does anyway, but cleaner).

### Concrete shape under Option B

```ts
formData["__photoAssignmentsByField"] = {
  "5_picture_of_pool_and_spa_if_applicable": [url1, url2, url3],
  "16_photo_of_pool_pump": [url1],
  // only entries for multi-photo fields with at least one photo
};
formData["5_picture_of_pool_and_spa_if_applicable"] = url1; // mirrored primary
formData["16_photo_of_pool_pump"]                    = url1;

formData["summary_items"] = [
  { text: "Observed algae in shallow end", photos: [url7] },
  { text: "Chlorinator inlet loose",        photos: [url8, url9] },
];
// `formData["107_summary"]` left as "" when summary_items is the source of truth.
```

### Resolver extension (deterministic, extends do-not-rewrites)

Pass 1 gains a preceding sub-step: **Pass 1a — multi-photo map**.

```
For each field in MULTI_PHOTO_FIELD_IDS (in template order):
  map = formData["__photoAssignmentsByField"]?.[fieldId] ?? null
  if map is a non-empty array:
    urls = []
    for each entry in map (cap at MULTI_PHOTO_CAP=4):
      match against allJobPhotosArr (URL match, else filename match)
      if matched and not already consumed:
        mark idx consumed, push resolved URL
      else if entry is external http(s) url not in pool:
        push entry verbatim (mirrors existing external-URL pass-through)
    store urls[] in multiFieldResolvedUrls.set(fieldId, urls)
    also mirror urls[0] into fieldResolvedUrl.set(fieldId, urls[0]) so Pass 1 (original)
      treats the field as "already resolved" and skips it
```

Original Pass 1, Pass 2, Pass 3 logic: **unchanged**. `fieldResolvedUrl` continues to carry the primary URL for single-slot fields. The new `multiFieldResolvedUrls` is a supplementary map, read only in the multi-photo render branch.

**Does Pass 2 sequential fallback still fire on multi-photo fields?** No. If a multi field has no `__photoAssignmentsByField` entry, it falls through to the original Pass 1 path: `formData[fieldId]` is either a legacy primary URL (Pass 1 resolves it normally, single photo rendered) or empty (Pass 2 can claim a sequential photo for slot 0 only — matches pre-mpy behavior for untouched legacy jobs). Legacy jobs with exactly one photo per field continue to render exactly as before.

**Q108 leftover math.** `consumedPhotoIdxs` is a single set shared across Pass 1a, Pass 1, Pass 2, the summary-items consumer, and Pass 3. Every URL claimed by a multi-field slot or a summary item is in this set. Pass 3's `photosQueue` is `allJobPhotosArr.filter((_, i) => !consumedPhotoIdxs.has(i))`. By construction, Q108 drains only what nothing else claimed — the hard invariant holds.

---

## Summary capacity policy — real numbers

Framing: the only email payload is the generated PDF. Photos embed inline via `doc.addImage(..., "FAST")`. The binding constraint is PDF size → Resend 40 MB wire (base64 inflation ~1.33×) → ~30 MB raw PDF ceiling.

**Measured/derived inputs:**
- Compressed photo: `COMPRESSION_OPTIONS.maxSizeMB = 1`, `maxWidthOrHeight = 1920`, `quality = 0.8`, output JPEG. Observed: typical ~250–500 KB, p95 ~800 KB.
- `fitPhoto` caps at 130×95 mm (`generate-pdf.ts:27-50`); 2×2 grid cell: ~62×47 mm, preserves JPEG bytes (layout is just transform).
- `addImage(..., "FAST")` stores the JPEG bytes ~verbatim; each image contributes roughly its source size to PDF bytes (plus a few KB object overhead).
- jsPDF per-photo CPU: ~30–80 ms FAST mode on typical server hardware. 40 photos ≈ 2–3 s. Vercel Fluid Compute default timeout 300 s — no pressure.
- PDF non-photo content (107 fields, section headers, disclaimer, signature): ~80–150 KB total.

**Typical non-summary photo budget per job** (from production-style jobs): 10–20 numbered-field photos + 5–15 Q108 leftovers = ~15–35 photos → 5–15 MB of PDF. Call it 12 MB average, 20 MB heavy.

**Summary budget math:**
- At 400 KB/photo average, **30 MB ceiling − 15 MB non-summary = 15 MB for summary ≈ 37 photos**.
- At 500 KB/photo (heavy), **30 − 20 = 10 MB ≈ 20 photos**.
- At 250 KB/photo (compressed well), **30 − 12 = 18 MB ≈ 72 photos**.

**Policy:**
- **Soft warning: 25 photos across all summary items.** Inline non-blocking chip under the summary editor: "25 photos in summary — PDF is ~15 MB. Large emails may load slowly." Chosen because 25 photos × 400 KB = 10 MB of summary alone, which is the point where combined PDF starts consistently exceeding 20 MB.
- **Hard stop: 40 photos across all summary items.** Blocked client-side (button disabled with tooltip) AND server-side in the save action ("Max 40 photos in summary. Remove some to add more."). Chosen because 40 × 400 KB = 16 MB of summary; combined with a 20 MB heavy non-summary case = 36 MB PDF → 48 MB email after base64 → Resend will reject. 40 is the ceiling that keeps *heavy* jobs deliverable.
- **No per-item photo cap.** Workers choose: one item with 20 photos, or 20 items with 1 photo each — same budget. Per-item caps just add friction without solving the actual constraint.
- **iPad UX sanity check:** field-worker flow realistically produces 2–8 items per job (from the existing paper form's structure). 15+ items is exceptional. 40 summary photos spread across ~5–10 items is the upper edge of what anyone will actually do. The policy bites before UX degrades.

No per-item hard stop. The total count is the one number that matters for email delivery.

---

## must_haves

**truths:**
- T1 — The five listed fields (Q5, Q16, Q25, Q40, Q71) accept up to 4 photos each. Every other photo field remains single-slot; no change in behavior or UI.
- T2 — Multi-photo storage lives at `formData["__photoAssignmentsByField"][fieldId]` as a `string[]`; `formData[fieldId]` mirrors the first URL for backward read-compat. No Prisma schema change.
- T3 — 3-pass resolver is extended, not rewritten. Pass 1a precedes Pass 1. Pass 2 gate (`!reviewed && !hasAnyResolvableExplicit`), Q108 drain, and the reviewed sentinel behave identically to today.
- T4 — Admin photo-assignment UI supports assigning up to 4 photos to one of the 5 eligible fields. Non-multi fields render a single-slot dropdown as today.
- T5 — `107_summary` is backed by a structured `formData["summary_items"] = { text, photos: string[] }[]` when the user creates items. Existing jobs whose `formData["107_summary"]` holds a plain string render identically in the PDF (no forced migration).
- T6 — Per-summary-item photos are claimed out of `job.photos` exactly once. Q108 leftover math subtracts summary-claimed URLs.
- T7 — Total summary photo count is capped at **40 server-side**; a soft warning appears at **25** in the UI.
- T8 — PDF pagination never orphans a multi-photo field label on one page from its images on the next, and never splits mid-photo. Same rule for summary items: label/text never separated from its first photo.
- T9 — Existing single-photo jobs (pre-mpy) render byte-equivalently: no divider change, no header change, no signature change, same question numbering, same wording.

**artifacts:**
- A1 — `src/lib/multi-photo.ts` (new): `MULTI_PHOTO_FIELD_IDS: ReadonlySet<string>`, `MULTI_PHOTO_CAP = 4`, `RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField"`, `RESERVED_SUMMARY_KEY = "summary_items"`, helper `readFieldPhotoUrls(formData, fieldId): string[]`.
- A2 — `src/lib/summary.ts` (new): `SummaryItem = { text: string; photos: string[] }`, `parseSummaryItems(formData): SummaryItem[] | null`, `SUMMARY_PHOTO_SOFT_LIMIT = 25`, `SUMMARY_PHOTO_HARD_LIMIT = 40`.
- A3 — Widen `FormData` in `src/lib/forms.ts` to `Record<string, unknown>`. Document reserved `__` prefix + `summary_items` as structured values.
- A4 — New server action `assignMultiFieldPhotos(jobId, fieldId, urls[])` in `src/lib/actions/photo-assignments.ts` (same file as `savePhotoAssignments`). Enforces 4-cap, draft-only, ownership (urls must be in `job.photos`), mirrors `urls[0]` into `formData[fieldId]`, sets `__photoAssignmentsReviewed = true`.
- A5 — Extension to `savePhotoAssignments` payload contract to accept slot-targeted strings `${fieldId}#${1..4}` for the five multi fields. Existing single-slot fields unchanged.
- A6 — `src/components/multi-photo-field.tsx` (new): 4-slot grid input replacing `PhotoFieldInput` only for the 5 eligible fields. Add / remove / reorder (move-up / move-down buttons — iPad-friendly, no drag-and-drop).
- A7 — `src/components/job-form.tsx` FieldRenderer branch: if `field.id ∈ MULTI_PHOTO_FIELD_IDS` → `MultiPhotoFieldInput`, else existing `PhotoFieldInput`. If `field.id === "107_summary"` → `SummaryItemsEditor`, else existing textarea.
- A8 — `src/components/summary-items-editor.tsx` (new): list of items, per-item textarea + photo picker (select photos from `job.photos` not already claimed elsewhere), add / remove / reorder, soft-warning chip at ≥25, add-button disabled at ≥40.
- A9 — New server action `saveSummaryItems(jobId, items[])` enforcing 40-photo hard cap + ownership check.
- A10 — `src/lib/actions/generate-pdf.ts`: Pass 1a, multi-photo grid render, summary-items grid render, extended `consumedPhotoIdxs` accounting. Q108 drain logic untouched structurally.

**key_links:**
- `src/lib/actions/generate-pdf.ts` — extend only
- `src/components/job-form.tsx` — branch FieldRenderer
- `src/components/photo-assignments.tsx` — extend select options for 5 fields
- `src/lib/actions/photo-assignments.ts` — add new action + extend save payload
- `src/lib/forms.ts` — widen FormData type
- `src/lib/photos.ts` — no changes (off-limits per brief)
- `prisma/schema.prisma` — **no migration** (Job.formData is already `Json?`)
- `src/lib/actions/photos.ts` — off-limits per brief

---

## Task 1 — Shared constants + widened FormData type

**files:**
- `src/lib/multi-photo.ts` (new)
- `src/lib/summary.ts` (new)
- `src/lib/forms.ts`

**action:**

### 1a. `src/lib/multi-photo.ts`
```ts
export const MULTI_PHOTO_FIELD_IDS: ReadonlySet<string> = new Set([
  "5_picture_of_pool_and_spa_if_applicable",
  "16_photo_of_pool_pump",
  "25_picture_of_cartridge",
  "40_picture_if_leak_is_present_at_chlorinator",
  "71_picture_of_leaks_on_valves_if_applicable",
]);

export const MULTI_PHOTO_CAP = 4;
export const RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField";

export function isMultiPhotoField(fieldId: string): boolean {
  return MULTI_PHOTO_FIELD_IDS.has(fieldId);
}

/**
 * Returns resolved URL strings for a multi-photo field, with legacy
 * fallback to `formData[fieldId]` when the reserved map is absent.
 * Never returns an array longer than MULTI_PHOTO_CAP.
 */
export function readFieldPhotoUrls(
  formData: Record<string, unknown> | null | undefined,
  fieldId: string,
): string[] {
  const map = formData?.[RESERVED_PHOTO_MAP_KEY];
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const entry = (map as Record<string, unknown>)[fieldId];
    if (Array.isArray(entry)) {
      return entry
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .slice(0, MULTI_PHOTO_CAP);
    }
  }
  const primary = formData?.[fieldId];
  return typeof primary === "string" && primary.length > 0 ? [primary] : [];
}
```

### 1b. `src/lib/summary.ts`
```ts
export type SummaryItem = { text: string; photos: string[] };

export const RESERVED_SUMMARY_KEY = "summary_items";
export const SUMMARY_PHOTO_SOFT_LIMIT = 25;
export const SUMMARY_PHOTO_HARD_LIMIT = 40;

/** null = no structured items stored (caller falls back to the legacy 107_summary blob). */
export function parseSummaryItems(
  formData: Record<string, unknown> | null | undefined,
): SummaryItem[] | null {
  const raw = formData?.[RESERVED_SUMMARY_KEY];
  if (!Array.isArray(raw)) return null;
  const out: SummaryItem[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text : "";
      const photos = Array.isArray(obj.photos)
        ? obj.photos.filter((p): p is string => typeof p === "string")
        : [];
      out.push({ text, photos });
    }
  }
  return out;
}

export function countSummaryPhotos(items: SummaryItem[]): number {
  return items.reduce((n, it) => n + it.photos.length, 0);
}
```

### 1c. `src/lib/forms.ts`
Change:
```ts
export type FormData = Record<string, string | boolean>;
```
to:
```ts
// Loose JSON bag. Reserved keys (prefixed with `__` or the literal
// `summary_items`) hold structured values — see src/lib/multi-photo.ts
// and src/lib/summary.ts. Regular template-field keys continue to hold
// string | boolean only; call sites cast accordingly.
export type FormData = Record<string, unknown>;
```
Audit and fix all read sites: if a caller was doing `fd[id]` and expecting `string | boolean`, add the appropriate narrowing (`typeof v === "string"` / `typeof v === "boolean"`). Do NOT add array/object handling in user-editable fields; reserved-key reads go through `readFieldPhotoUrls` / `parseSummaryItems` only.

**verify:**
- `bunx tsc --noEmit` (will be run by proof plan — mentally walk the narrowed sites).
- `MULTI_PHOTO_FIELD_IDS` contains exactly the five listed ids, each appearing verbatim in `scripts/extraction-output.json`.
- `readFieldPhotoUrls` on a legacy job (`__photoAssignmentsByField` absent, `formData["5_..."] = "url"`) returns `["url"]`.
- `readFieldPhotoUrls` on a new-shape job returns the reserved-map array, capped at 4.
- `parseSummaryItems` on a legacy job (`summary_items` absent) returns `null`.

**done:**
- Helper constants and types exported.
- `FormData` widened; no remaining `string | boolean` assumption at read sites.
- Zero behavior change in isolation.

---

## Task 2 — Server action for multi-photo field assignment

**files:**
- `src/lib/actions/photo-assignments.ts`

**action:**

Add a new exported action `assignMultiFieldPhotos(jobId, fieldId, urls)`:

```ts
import {
  MULTI_PHOTO_FIELD_IDS,
  MULTI_PHOTO_CAP,
  RESERVED_PHOTO_MAP_KEY,
} from "@/lib/multi-photo";

export async function assignMultiFieldPhotos(
  jobId: string,
  fieldId: string,
  urls: string[],
): Promise<{ success: boolean; error?: string }> {
  if (!MULTI_PHOTO_FIELD_IDS.has(fieldId)) {
    return { success: false, error: "Field is not multi-photo eligible" };
  }
  if (urls.length > MULTI_PHOTO_CAP) {
    return { success: false, error: `Max ${MULTI_PHOTO_CAP} photos per field` };
  }

  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can assign photos" };
  }

  const photoUrlSet = new Set(
    (job.photos as PhotoMetadata[]).map((p) => p.url),
  );
  for (const u of urls) {
    if (!photoUrlSet.has(u)) {
      return { success: false, error: "Unknown photo in payload" };
    }
  }

  // Deduplicate preserving order; invariant: one URL, one owner.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const u of urls) if (!seen.has(u)) { seen.add(u); deduped.push(u); }

  const existing = (job.formData as FormData | null) ?? {};
  const mapRaw = existing[RESERVED_PHOTO_MAP_KEY];
  const currentMap: Record<string, string[]> =
    mapRaw && typeof mapRaw === "object" && !Array.isArray(mapRaw)
      ? { ...(mapRaw as Record<string, string[]>) }
      : {};

  // Steal URLs from other multi-field entries if collisions exist (one-owner).
  for (const otherId of Object.keys(currentMap)) {
    if (otherId === fieldId) continue;
    currentMap[otherId] = currentMap[otherId].filter((u) => !seen.has(u));
    if (currentMap[otherId].length === 0) delete currentMap[otherId];
  }
  if (deduped.length > 0) currentMap[fieldId] = deduped;
  else delete currentMap[fieldId];

  const next: FormData = { ...existing };
  next[RESERVED_PHOTO_MAP_KEY] = currentMap;
  next[fieldId] = deduped[0] ?? ""; // mirror primary for legacy readers
  next[REVIEWED_FLAG] = true;

  // Also steal from single-slot fields to preserve one-owner (the 5 multi
  // fields grabbing a URL that a legacy single-slot field currently claims).
  // Out of scope: the admin UI drives single-slot clearing through
  // savePhotoAssignments; this action is narrow-scope on one multi field.

  const updated = await db.job.updateMany({
    where: { id: jobId, status: "DRAFT" },
    data: { formData: next as unknown as object },
  });
  if (updated.count === 0) {
    return { success: false, error: "Job is no longer editable" };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/admin");
  return { success: true };
}
```

Extend `savePhotoAssignments` payload to accept slot-targeted strings for the 5 multi fields:
- A target of form `${fieldId}#${n}` where `fieldId ∈ MULTI_PHOTO_FIELD_IDS` and `n ∈ 1..4` means "this photo goes into slot n of fieldId."
- Payload processing: group by base fieldId, sort by slot index, dedupe, build `currentMap[fieldId] = [url_slot1, url_slot2, ...]`, mirror slot-1 into `formData[fieldId]`.
- Non-multi field targets, `UNASSIGNED`, and `Q108_ID` behave identically to today.
- 4-cap enforced by rejecting `n > MULTI_PHOTO_CAP` and `>4 slots assigned for one fieldId`.

**verify:**
- Call `assignMultiFieldPhotos(draftJobId, "5_picture_of_pool_and_spa_if_applicable", [url1, url2, url3])` on a job with those URLs in `job.photos`. Reload job: `formData["__photoAssignmentsByField"]["5_..."]` equals `[url1, url2, url3]`; `formData["5_..."]` equals `url1`; `formData["__photoAssignmentsReviewed"] === true`.
- Call with a 5th URL → returns `"Max 4 photos per field"`. DB unchanged.
- Call with URL not in `job.photos` → returns `"Unknown photo in payload"`. DB unchanged.
- Call on a SUBMITTED job → returns `"Only draft jobs can assign photos"`.
- Extended `savePhotoAssignments` with `{ [url1]: "5_...#1", [url2]: "5_...#2", [url3]: "16_photo_of_pool_pump" }` → after save, map has `{ "5_...": [url1, url2], "16_...": [url3] }` and `formData["5_..."] = url1`, `formData["16_..."] = url3`.

**done:**
- Both actions enforce 4-cap server-side.
- Ownership stealing keeps one-URL-one-owner invariant.
- Legacy single-slot payloads through `savePhotoAssignments` are byte-equivalent to pre-mpy output.

---

## Task 3 — Extend Pass 1 with multi-photo sub-pass

**files:**
- `src/lib/actions/generate-pdf.ts`

**action:**

Introduce `multiFieldResolvedUrls: Map<string, string[]>` alongside `fieldResolvedUrl`. Insert Pass 1a **before** the existing Pass 1 loop (around `:174`):

```ts
// Pass 1a — multi-photo fields claim their slot list from the reserved map,
// preserving order. Consumed indices are shared with subsequent passes so
// nothing is double-rendered. When the reserved entry is missing, the field
// falls through to the legacy single-string Pass 1 path untouched.
const multiFieldResolvedUrls = new Map<string, string[]>();
const photoMapRaw = formData?.[RESERVED_PHOTO_MAP_KEY];
const photoMap: Record<string, string[]> =
  photoMapRaw && typeof photoMapRaw === "object" && !Array.isArray(photoMapRaw)
    ? (photoMapRaw as Record<string, string[]>)
    : {};

for (const field of template.fields) {
  if (field.type !== "photo") continue;
  if (!MULTI_PHOTO_FIELD_IDS.has(field.id)) continue;
  const entries = Array.isArray(photoMap[field.id])
    ? photoMap[field.id].slice(0, MULTI_PHOTO_CAP)
    : null;
  if (!entries || entries.length === 0) continue;

  const resolved: string[] = [];
  for (const raw of entries) {
    if (typeof raw !== "string" || !raw) continue;
    const matchesRaw = raw.startsWith("http")
      ? (p: PhotoMetadata) => p.url === raw
      : (p: PhotoMetadata) => p.filename === raw;
    const idx = allJobPhotosArr.findIndex(
      (p, i) => !consumedPhotoIdxs.has(i) && matchesRaw(p),
    );
    if (idx >= 0) {
      consumedPhotoIdxs.add(idx);
      resolved.push(allJobPhotosArr[idx].url);
    } else if (
      raw.startsWith("http") &&
      !allJobPhotosArr.some((p) => p.url === raw)
    ) {
      resolved.push(raw); // external URL pass-through (matches Pass 1 semantics)
    }
    // orphan filename → drop from this field's slot list; Pass 2 will not
    // try to fill from the legacy formData primary because Pass 1 still sees
    // fieldResolvedUrl set below.
  }

  multiFieldResolvedUrls.set(field.id, resolved);
  // Pin the field as "already resolved" so Pass 1 skips it and Pass 2 can't
  // claim a sequential photo into slot 0. Primary URL is first resolved URL,
  // or the legacy mirrored string if resolved ended up empty.
  const primary =
    resolved[0] ??
    (typeof formData?.[field.id] === "string" ? (formData[field.id] as string) : "");
  if (primary) fieldResolvedUrl.set(field.id, primary);
}
```

**No change** to the existing Pass 1, Pass 2 gate, Pass 2 loop, or Pass 3 `photosQueue` computation.

**verify (by reasoning):**
- Legacy job (no `__photoAssignmentsByField`): Pass 1a is a no-op. Pass 1 reads `formData["5_..."]` as a string, matches normally. Pass 2 gate behavior identical. Output byte-equivalent.
- New-shape job, 3 photos in Q5: Pass 1a consumes 3 indices, stores `multiFieldResolvedUrls["5_..."] = [u1, u2, u3]`, pins `fieldResolvedUrl["5_..."] = u1`. Pass 1 sees the field as resolved, skips. Pass 2 gate opens/closes as before; multi field isn't visited. Pass 3 `photosQueue` excludes those 3 indices.
- External-URL slot preserved (non-pool URL): pushed verbatim, matches existing Pass 1 external-URL pass-through behavior.

**done:**
- Pass 1a is the only new code. Existing passes literally unchanged.
- `consumedPhotoIdxs` accounting keeps Q108 drain correct.
- Reviewed sentinel read at `:214` unchanged; `hasAnyResolvableExplicit` at `:215-220` picks up `fieldResolvedUrl` entries pinned by Pass 1a, so the gate closes correctly for new-shape jobs.

---

## Task 4 — PDF render: multi-photo grid

**files:**
- `src/lib/actions/generate-pdf.ts`

**action:**

In the non-Q108 photo branch (`:385-431`), add a multi-photo early-return **before** the existing single-photo render:

```ts
if (MULTI_PHOTO_FIELD_IDS.has(field.id)) {
  const urls = multiFieldResolvedUrls.get(field.id) ?? [];
  if (urls.length <= 1) {
    // 0 or 1 photo: fall through to the existing single-photo render,
    // using fieldResolvedUrl which Pass 1a already pinned (or Pass 1 set).
    // No branching needed below.
  } else {
    await renderMultiPhotoGrid(doc, field, urls, photoLabelLines, labelHMeta);
    continue;
  }
}
```

Grid helper (new private async function in the same module):

```ts
// 2×2 grid at half-content-width, uniform cells. 2 photos = row 1 only,
// 3 photos = row 1 full + row 2 left, 4 photos = full grid.
async function renderMultiPhotoGrid(
  doc: jsPDF,
  field: FormField,
  urls: string[],
  labelLines: string[],
  labelH: number,
) {
  const CELL_MAX_W = (CONTENT_WIDTH - 4) / 2; // mm; 4mm gutter
  const CELL_MAX_H = 52; // mm; 2 rows × 52 + 4 gutter + 8 bottom = ~116mm block
  const GUTTER = 4;
  const rows = Math.ceil(urls.length / 2);
  const blockH = labelH + rows * CELL_MAX_H + (rows - 1) * GUTTER + 8;

  if (y + blockH > 280) { doc.addPage(); y = MARGIN; }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(labelLines, MARGIN, y);
  y += labelH;

  for (let i = 0; i < urls.length; i++) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const cellY = y + row * (CELL_MAX_H + GUTTER);
    const cellX = MARGIN + col * (CELL_MAX_W + GUTTER);
    try {
      const res = await fetch(urls[i]);
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString("base64");
      const imgProps = doc.getImageProperties(b64);
      // scaled fitPhoto for the smaller cell
      const { imgW, imgH } = fitPhotoToCell(imgProps, CELL_MAX_W, CELL_MAX_H);
      const imgX = cellX + (CELL_MAX_W - imgW) / 2;
      const imgY = cellY + (CELL_MAX_H - imgH) / 2;
      doc.addImage(b64, "JPEG", imgX, imgY, imgW, imgH, undefined, "FAST");
    } catch {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.text("[photo could not be loaded]", cellX, cellY + CELL_MAX_H / 2);
    }
  }
  y += rows * CELL_MAX_H + (rows - 1) * GUTTER + 8;
}

function fitPhotoToCell(
  props: { width: number; height: number },
  maxW: number,
  maxH: number,
): { imgW: number; imgH: number } {
  const ar = props.height / props.width;
  let imgW = maxW;
  let imgH = ar * imgW;
  if (imgH > maxH) { imgH = maxH; imgW = imgH / ar; }
  return { imgW, imgH };
}
```

**Why 2×2 over vertical stack:** a vertical stack of 4 photos at current `fitPhoto` (95 mm cap) is 4×95 + 4×6 gutter = 404 mm → spans 2 pages per question minimum. A 2×2 grid fits all 4 photos + label in ~116 mm (half a page), preserves question unity, and reads as "here are the pump photos" at a glance. Grid cells at 95×52 mm are still larger than the typical printed-form photo boxes and keep EXIF detail visible.

**Ordering:** slot index (storage order) is row-major: slot 1 = top-left, slot 2 = top-right, slot 3 = bottom-left, slot 4 = bottom-right.

**Pagination rule:** the whole grid + label is treated as one block. If `y + blockH > 280`, `addPage()` first, then draw. No mid-photo split (each image stays inside its 2×2 cell), no orphaned label (label drawn immediately before the first image on the same page).

**verify:**
- Q5 with 1 photo: falls through to existing single-photo render. PDF byte-equivalent to today's single-photo rendering.
- Q16 with 2 photos: 1×2 row (row 1 full, row 2 empty), ~64 mm tall + label.
- Q25 with 3 photos: top row full, bottom-left only, ~116 mm tall + label.
- Q40 with 4 photos: full 2×2, ~116 mm tall + label.
- Grid placed at bottom of page with insufficient height: `addPage()` before drawing, no split.
- One photo 404s during fetch: its cell renders "[photo could not be loaded]"; neighbors render normally. No cascade failure.

**done:**
- Single-photo path unchanged (multi fields with ≤1 URL fall through).
- 2×2 block never splits mid-photo.
- Label always on the same page as the first image.

---

## Task 5 — Per-field multi-photo upload UI

**files:**
- `src/components/multi-photo-field.tsx` (new)
- `src/components/job-form.tsx`

**action:**

### 5a. `MultiPhotoFieldInput` component
Render 4 slots in a 2×2 grid. Each slot shows either:
- empty (dashed border, tap-to-upload)
- filled (thumbnail with `×` remove + `↑` / `↓` reorder affordances)

Behavior:
- Tap empty slot → open `<input type="file" accept="image/*">`, compress via `imageCompression` (existing `COMPRESSION_OPTIONS`), POST to `/api/photos/upload`, call `savePhotoMetadata`, then call `assignMultiFieldPhotos(jobId, fieldId, [...currentUrls, newUrl])`. Same upload pipeline as `PhotoFieldInput` — no new upload endpoint.
- Tap `×` on a filled slot → call `assignMultiFieldPhotos(jobId, fieldId, currentUrls.filter(u => u !== removedUrl))`. The photo stays in `job.photos` (available in the gallery + re-assignable via the admin tool); only the slot binding is cleared.
- Tap `↑` / `↓` → swap adjacent, call `assignMultiFieldPhotos` with reordered array.
- Disable all controls when `disabled` prop set (submitted state).
- Show filled-slot count: "3 of 4 photos" below the grid.

Client-side cap: if `currentUrls.length === MULTI_PHOTO_CAP`, empty slots render as disabled with tooltip "Max 4 photos per question."

This component uses its own local state + revalidation via `router.refresh()` after the action succeeds (matches `PhotoAssignmentsEditor` pattern). It does NOT use `react-hook-form` for the array — react-hook-form is bypassed for multi-photo fields because the primary URL mirror at `formData[fieldId]` is what the form schema sees, and that's maintained server-side.

To keep the form-wide auto-save consistent: after `assignMultiFieldPhotos` succeeds, call `router.refresh()`. The next page load sees `formData[fieldId] = urls[0]` and the form hydrates with a populated primary URL string — matching the existing zod schema expectation.

### 5b. `FieldRenderer` branch in `src/components/job-form.tsx`
At the `case "photo":` branch:
```ts
case "photo":
  if (MULTI_PHOTO_FIELD_IDS.has(field.id)) {
    return <MultiPhotoFieldInput field={field} jobId={jobId} disabled={disabled} />;
  }
  return <PhotoFieldInput .../>; // unchanged
```

**verify:**
- Open a draft job, scroll to Q5 → see 2×2 grid of 4 slots. All empty → "0 of 4 photos."
- Tap slot 1 → camera/library picker → upload → refresh → slot 1 filled, "1 of 4 photos."
- Fill slots 1–4 → all disabled empty slots gone, cap indicator shows "4 of 4 photos," tap on filled → reorder or remove UI.
- Tap `↓` on slot 1 → slot 1 and slot 2 swap. `formData["5_..."]` mirrors new primary (what was slot 2).
- Remove slot 1 → photo stays in gallery; `formData["__photoAssignmentsByField"]["5_..."]` drops that URL; `formData["5_..."]` becomes the new primary (old slot 2).
- Q16 (single-slot for the non-multi fields) is unchanged — verify by navigating to a non-multi photo field on the same page.
- Submitted job: grid renders read-only with thumbnails, no controls.

**done:**
- Only the 5 multi fields render the new component.
- Server-side cap enforced even if client is tampered with.
- Existing `PhotoFieldInput` code path is unchanged.

---

## Task 6 — Admin photo-assignment UI: slot selector

**files:**
- `src/components/photo-assignments.tsx`
- `src/lib/actions/photo-assignments.ts` (extend `savePhotoAssignments` payload — already listed in Task 2, but the UI wiring lands here)

**action:**

In the `<select>` per photo (`photo-assignments.tsx:99-113`):
- For each multi-photo field, expand to 4 options: "5. Picture of Pool and Spa — slot 1", "... slot 2", "... slot 3", "... slot 4". Option value = `${fieldId}#${slotN}`.
- Non-multi fields render a single option as today (value = `fieldId`, no slot suffix).
- `UNASSIGNED` and `Q108_ID` options unchanged.

Initial-assignment derivation: extend the `urlToField` map build in `initialAssignments` (lines 41-51) to also read `formData["__photoAssignmentsByField"]`. For each entry in the reserved map, map `url → ${fieldId}#${slotIndex}`.

Client-side friction on collision: if the admin assigns slot 2 of Q5 to a URL already in slot 2 of Q5 (or if two photos are targeting the same slot), show a toast "Two photos can't share the same slot" and disable save until resolved. Simpler: **always** renumber slots per field at save time (the inverter in `savePhotoAssignments` already does "first wins" — extend: group by base fieldId, sort by slot index ascending, dedupe, pack to slots 1..N). So the UI just lets admin pick slot numbers; the server normalizes.

Other photo fields (the ~20 non-multi photo fields): dropdown still shows one option per field, one slot. No visual bloat — slot 1 is implicit for single-slot fields.

**verify:**
- Open a draft with 4 photos in the gallery. Scroll to assignment tool. Each dropdown lists: Unassigned, every non-multi photo field once, every multi-photo field as 4 slots, Additional photos (Q108). Total option count = 20 + 5×4 + 2 = ~42.
- Assign photo A to "5. ... slot 1" and photo B to "5. ... slot 2." Save. `formData["__photoAssignmentsByField"]["5_..."]` = `[A, B]`. `formData["5_..."]` = A.
- Assign photo C to "5. ... slot 3" but leave slot 2 unfilled (only A in slot 1, C in slot 3 in UI). Save. Server packs to `[A, C]` — slot 3 normalized to slot 2.
- Assign 5 photos to 5 different slots of Q5 (UI shouldn't allow, but test the server). Server enforces cap via the Task 2 cap check — rejects with error; toast shown.

**done:**
- `<select>` expansion only for the 5 multi fields; zero visual change for the others.
- Slot normalization server-side prevents gaps.
- `__photoAssignmentsByField` + primary mirror both updated on save.

---

## Task 7 — Summary items schema + read adapter

**files:**
- `src/lib/summary.ts` (extended from Task 1)
- `src/lib/actions/summary.ts` (new)

**action:**

### 7a. Extend `src/lib/summary.ts` (from Task 1)
Already exports `SummaryItem`, `parseSummaryItems`, `countSummaryPhotos`, and the limits. Add:
```ts
export function collectSummaryPhotoUrls(items: SummaryItem[]): Set<string> {
  const s = new Set<string>();
  for (const it of items) for (const u of it.photos) s.add(u);
  return s;
}
```

### 7b. `src/lib/actions/summary.ts` (new) — `saveSummaryItems` action
```ts
"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { PhotoMetadata } from "@/lib/photos";
import type { FormData } from "@/lib/forms";
import {
  type SummaryItem,
  RESERVED_SUMMARY_KEY,
  SUMMARY_PHOTO_HARD_LIMIT,
  countSummaryPhotos,
} from "@/lib/summary";

export async function saveSummaryItems(
  jobId: string,
  items: SummaryItem[],
): Promise<{ success: boolean; error?: string }> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can edit summary" };
  }

  // Normalize: clamp text, dedupe photos within each item.
  const normalized: SummaryItem[] = items.map((it) => {
    const seen = new Set<string>();
    const photos: string[] = [];
    for (const u of it.photos ?? []) {
      if (typeof u === "string" && u && !seen.has(u)) {
        seen.add(u);
        photos.push(u);
      }
    }
    return { text: typeof it.text === "string" ? it.text : "", photos };
  });

  // Hard cap — total photos across all items.
  if (countSummaryPhotos(normalized) > SUMMARY_PHOTO_HARD_LIMIT) {
    return {
      success: false,
      error: `Max ${SUMMARY_PHOTO_HARD_LIMIT} photos in summary. Remove some to add more.`,
    };
  }

  // Ownership: every summary photo URL must exist in job.photos.
  const photoUrlSet = new Set(
    (job.photos as PhotoMetadata[]).map((p) => p.url),
  );
  for (const it of normalized) {
    for (const u of it.photos) {
      if (!photoUrlSet.has(u)) {
        return { success: false, error: "Unknown photo in summary" };
      }
    }
  }

  const existing = (job.formData as FormData | null) ?? {};
  const next: FormData = { ...existing };
  if (normalized.length === 0) {
    delete next[RESERVED_SUMMARY_KEY];
  } else {
    next[RESERVED_SUMMARY_KEY] = normalized;
  }
  // Do NOT touch formData["107_summary"] — if it holds a legacy blob and
  // the user switches to structured items, the blob is superseded by the
  // array but kept for historical viewing. parseSummaryItems returning a
  // non-null array tells the PDF which source to use.

  const updated = await db.job.updateMany({
    where: { id: jobId, status: "DRAFT" },
    data: { formData: next as unknown as object },
  });
  if (updated.count === 0) {
    return { success: false, error: "Job is no longer editable" };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { success: true };
}
```

**verify:**
- Save 3 items totaling 10 photos → success, `formData["summary_items"]` is the array, `formData["107_summary"]` untouched.
- Save items with 41 total photos → returns hard-cap error. DB unchanged.
- Save items referencing a URL not in `job.photos` → returns ownership error.
- Save with `items = []` → removes the `summary_items` key; legacy blob (if any) still readable.
- `parseSummaryItems` on output returns the array back; legacy jobs without the key return `null`.

**done:**
- Server action enforces 40-photo hard cap + ownership.
- Reserved key deleted when items array empty.
- Legacy blob untouched.

---

## Task 8 — Summary items editor UI

**files:**
- `src/components/summary-items-editor.tsx` (new)
- `src/components/job-form.tsx`

**action:**

### 8a. `SummaryItemsEditor` component
Layout: a vertical list of item cards, each showing:
- Header row with "Item N" + `↑` / `↓` / `×` buttons (iPad-friendly ≥44 px hit targets).
- Textarea for `text`.
- Photo picker: a grid of ALL photos in `job.photos` where the admin can toggle selection per item. Selected photos are owned by this item. A photo that's owned by another item (or a multi-field slot, or Q108 via the non-reviewed path) shows disabled with an "Owned by Q16" / "Owned by item 3" / "Owned by Q108" label — the one-owner invariant made visible.

Controls below the list:
- "Add item" button (disabled if total summary photos ≥ HARD_LIMIT AND the current pending-state would exceed it on save — but the add-item itself is free since it adds zero photos).
- Soft-warning chip when total summary photos ≥ SOFT_LIMIT (25): "Summary is getting large — 26 photos ≈ 10 MB of PDF. Keep photo count in mind for email delivery." Non-blocking.
- Hard error banner when total summary photos > HARD_LIMIT (40) as a client-side pre-submit check: "Max 40 photos in summary. Remove some before saving." Save button disabled.

Save strategy: autosave 2 s after the last keystroke (same debounce pattern as `JobForm.saveFormData`). Call `saveSummaryItems(jobId, items)`. On server-side cap rejection, show toast + revert to last-known-good state.

Read-side hydration: on mount, call `parseSummaryItems(initialFormData)`. If `null` and `initialFormData["107_summary"]` is a non-empty string → offer a "Migrate blob to items" button that seeds items = `[{ text: blob, photos: [] }]`. This is user-initiated, not forced.

Reordering: `↑` / `↓` buttons (no drag-and-drop — iPad DnD is flaky in Safari web). Each button moves the item one position; `↑` disabled on index 0, `↓` disabled on last.

Ownership conflict resolution on save: the editor tracks which photos are "claimed" by each item locally. If the admin selects a photo for item 2 that was previously in item 1, item 1 loses it (same one-owner principle as multi-field UI). No save-time rejection — the UI makes ownership transfer obvious.

### 8b. `FieldRenderer` branch
```ts
case "textarea":
  if (field.id === "107_summary") {
    return <SummaryItemsEditor jobId={jobId} field={field} disabled={disabled} />;
  }
  return <Textarea .../>; // unchanged
```

**verify:**
- Open a draft with empty summary → "No summary items yet. Tap Add item to start."
- Add 3 items, type text in each, select 2 photos for item 1 and 1 photo for item 2 → autosave → reload → items persist in order.
- Reorder item 2 up → item order is [2,1,3] → autosave → reload → order persists.
- Remove item 1 → photos return to "unowned" pool (still in `job.photos`, unassigned).
- Soft-warn appears at 25 total summary photos; hard-stop banner at 41 (save disabled until photos removed).
- Legacy job with a blob in `formData["107_summary"]` and no `summary_items`: editor shows "Migrate blob to items" button with blob preview. Click → seeds `[{ text: blob, photos: [] }]`. User can then split.
- Submitted job: editor renders read-only.

**done:**
- Only `107_summary` field renders the editor; no other textarea affected.
- Soft + hard caps wired to UI indicators.
- Legacy blob viewable; migration user-initiated.

---

## Task 9 — PDF render: summary items + Q108 accounting

**files:**
- `src/lib/actions/generate-pdf.ts`

**action:**

### 9a. Early-claim summary photos for Q108 math
Right after Pass 1a (Task 3), before existing Pass 1:
```ts
// Summary items claim their photos first so Pass 2 sequential fallback
// and Pass 3 Q108 drain both see the correct "already owned" set.
const summaryItems = parseSummaryItems(formData);
if (summaryItems) {
  for (const item of summaryItems) {
    for (const url of item.photos) {
      const idx = allJobPhotosArr.findIndex(
        (p, i) => !consumedPhotoIdxs.has(i) && p.url === url,
      );
      if (idx >= 0) consumedPhotoIdxs.add(idx);
      // URL not in pool → still will render in the summary branch via
      // external-URL pass-through. Don't mark anything consumed.
    }
  }
}
```

This ensures `photosQueue` at Pass 3 excludes summary-claimed URLs, honoring the hard invariant.

### 9b. Render summary at the `107_summary` field's slot
In the non-photo field loop, replace the generic textarea render for `107_summary` with a branching:
```ts
if (field.id === "107_summary" && summaryItems !== null) {
  await renderSummaryItems(doc, summaryItems);
  continue;
}
// else fall through to existing text/textarea rendering — legacy blob path
```

Helper:
```ts
async function renderSummaryItems(doc: jsPDF, items: SummaryItem[]) {
  // Section header "107. Summary"
  if (y + 10 > 280) { doc.addPage(); y = MARGIN; }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("107. Summary", MARGIN, y);
  y += 6;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Item heading
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    const itemLabel = `Item ${i + 1}`;
    const textLines = doc.splitTextToSize(item.text || "—", CONTENT_WIDTH);
    const textH = textLines.length * 4 + 2;
    // Rough photo block height for pagination: 2×2 grid or less.
    const rows = Math.ceil(item.photos.length / 2);
    const photosH = rows > 0 ? rows * 52 + (rows - 1) * 4 + 4 : 0;
    const itemBlockH = 6 + textH + photosH + 4;

    // Keep item heading + first line of text on the same page as the block start.
    if (y + 6 + Math.min(textH, 20) > 280) { doc.addPage(); y = MARGIN; }
    doc.text(itemLabel, MARGIN, y);
    y += 5;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    // Text paginates freely — a long text may span pages naturally.
    for (const line of textLines) {
      if (y + 4 > 280) { doc.addPage(); y = MARGIN; }
      doc.text(line, MARGIN, y);
      y += 4;
    }
    y += 2;

    // Photos — 2×2 grid, same helper as multi-field with different arg.
    if (item.photos.length > 0) {
      await renderSummaryPhotoGrid(doc, item.photos);
    }

    y += 4;
  }
}
```

`renderSummaryPhotoGrid` is a near-copy of `renderMultiPhotoGrid` without the label (item heading already drawn).

Do NOT alter Q108 handling or the safety drain.

**verify:**
- Legacy job with `formData["107_summary"] = "Long text here"` and no `summary_items`: PDF renders same textarea output as pre-mpy (`generate-pdf.ts:433-471`). Byte-equivalent.
- New job with 2 items, each with 2 photos: PDF shows "107. Summary" heading, "Item 1" + text + 2 photos in a row, "Item 2" + text + 2 photos.
- New job with 1 item containing 10 photos: 2×2 grid paginates to 3 blocks (4+4+2) across pages; no orphaned item heading.
- Q108 for the new-shape job: photos claimed by summary items do NOT appear. Photos claimed by multi-field slots do NOT appear. Only truly unassigned photos drain.
- External URL in a summary item (not in pool): rendered verbatim; Pass 3 pool index unaffected.

**done:**
- Legacy blob render path unchanged.
- Summary items render with 2×2 grids.
- Q108 drain excludes summary-claimed URLs.
- No mid-photo page breaks; item heading never orphaned from its first line of text.

---

## Execution order + commit messages

One atomic commit per task, in order:

1. `feat(260417-mpy): shared multi-photo + summary constants and widen FormData` — `src/lib/multi-photo.ts`, `src/lib/summary.ts`, `src/lib/forms.ts`
2. `feat(260417-mpy): assignMultiFieldPhotos action + slot-aware savePhotoAssignments` — `src/lib/actions/photo-assignments.ts`
3. `feat(260417-mpy): Pass 1a multi-photo resolver in generate-pdf` — `src/lib/actions/generate-pdf.ts`
4. `feat(260417-mpy): 2×2 grid PDF render for multi-photo fields` — `src/lib/actions/generate-pdf.ts`
5. `feat(260417-mpy): MultiPhotoFieldInput with 4-slot grid UI` — `src/components/multi-photo-field.tsx`, `src/components/job-form.tsx`
6. `feat(260417-mpy): slot selector in admin photo-assignment UI` — `src/components/photo-assignments.tsx`
7. `feat(260417-mpy): saveSummaryItems action + helpers` — `src/lib/actions/summary.ts`, `src/lib/summary.ts`
8. `feat(260417-mpy): SummaryItemsEditor with soft + hard photo caps` — `src/components/summary-items-editor.tsx`, `src/components/job-form.tsx`
9. `feat(260417-mpy): summary items PDF render + Q108 leftover accounting` — `src/lib/actions/generate-pdf.ts`

Each commit builds cleanly on the previous — the commits are ordered so the server-side data shape is in place before the UI that writes it, and Pass 1a is present before the grid render that needs it.

---

## Proof plan (post-execution)

1. `bunx tsc --noEmit` — no TS errors anywhere. FormData widening must not leak untyped values into non-photo read sites.
2. `bun run build` — Next.js build succeeds.
3. **Legacy byte-equivalence smoke:** pick one of the two SUBMITTED seed jobs, download the PDF, save as `legacy-before.pdf`. After deploy, download again, save as `legacy-after.pdf`. `diff` the text layer (e.g. via `pdftotext`); expected: identical. Photo layout: visually confirm identical placement of photos for Q5/Q16/Q25/Q40/Q71 (each rendered as a single photo since legacy data has no `__photoAssignmentsByField`).
4. **Multi-photo happy path:** reopen a draft (via the existing Task 1 of do8). Upload 3 photos to Q5 via the new grid. Submit. PDF: Q5 renders a row of 3 photos in a 2×2 grid (top full + bottom-left). Other photo fields unchanged. Q108 drains gallery extras if any.
5. **Summary happy path:** in the same reopened draft, create 2 summary items with text; attach 2 photos to item 1 and 1 photo to item 2. Submit. PDF: "107. Summary" heading, Item 1 + text + 2-photo row, Item 2 + text + 1 photo. Q108 drains any unassigned remaining photos.
6. **Caps enforcement:** try to assign 5 photos to Q5 — server returns `"Max 4 photos per field"`. Try to save summary items totaling 41 photos — server returns hard-cap error. UI reflects both cases.
7. **Q108 invariant:** assign 2 photos to Q5, 1 photo to item 1 of summary, leave 3 photos unassigned. PDF: Q5 shows 2 photos, summary item 1 shows 1, Q108 shows exactly 3 photos. No duplicates, no missing.
8. **Pagination edge:** create a multi field with 4 photos placed near the bottom of a page. PDF: grid moves to next page together with label — no orphan.

---

## Blockers / risks

- **FormData type widening blast radius.** Changing `FormData` from `Record<string, string | boolean>` to `Record<string, unknown>` may surface narrow-type assumptions in callers. Mitigation: Task 1 includes an explicit audit pass. Known read sites: `generate-pdf.ts` (already uses `typeof` guards at photo fields), `job-form.tsx` (uses zod schema, not FormData directly), `submit.ts` (iterates field IDs, doesn't assume value types), `photo-assignments.ts` (type-guards already).
- **iPad Safari reorder UX.** Using `↑`/`↓` buttons instead of drag-and-drop. Flagged rather than risked: DnD in iOS Safari is unreliable for non-native web apps and would add significant code + test surface. Buttons are boring but correct.
- **External URL edge case in multi-photo.** A `__photoAssignmentsByField` entry that's an `http(s)://` URL not present in `job.photos` (unlikely but possible via hand-edited JSON or a future import feature): Pass 1a passes it through verbatim, matching Pass 1 semantics. No invariant violation, but a forensic reader won't find the photo in `job.photos`. Acceptable — matches existing Pass 1 behavior.
- **Legacy `savePhotoAssignments` compat.** Admin UI's existing single-slot `<select>` payload (target = `fieldId`) must keep working even after the slot-suffix extension. Task 2 keeps both accepted: a bare `fieldId` target (non-multi) resolves as today; `fieldId#N` is the new form. Non-multi fields can still accept bare `fieldId` because they have no slots — prevents regression on the 20+ single-slot photo fields.
- **No Prisma migration.** `Job.formData` is already `Json?`. All new structured data lives inside that JSON. No schema drift; no migration window.
- **Autosave collision between form's field-level autosave (`saveFormData`) and the summary/multi-field dedicated actions.** The summary editor writes via `saveSummaryItems`, which touches `formData["summary_items"]` and leaves everything else alone. The form's `saveFormData` writes the full form object. If both fire within the 2 s debounce, the last writer wins on the FULL formData object. Mitigation: both actions do `{ ...existing }` merges, but the form's `saveFormData` pulls its `existing` from the client-side RHF state which won't contain `summary_items`. To avoid clobbering, `saveFormData` must PRESERVE unknown keys from the DB row on write — read current job.formData, `{ ...currentJob.formData, ...rhfState }`, then write. Add this preservation in Task 1 as part of the FormData widening pass, touching `src/lib/actions/forms.ts` if needed. Flagged as a must-check.
