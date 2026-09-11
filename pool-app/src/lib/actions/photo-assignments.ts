"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { PhotoMetadata } from "@/lib/photos";
import type { FormData, FormField } from "@/lib/forms";
import {
  getMultiPhotoCap,
  RESERVED_PHOTO_MAP_KEY,
  ADDITIONAL_PHOTOS_FIELD_ID,
  ADDITIONAL_PHOTOS_CAP,
  MULTI_PHOTO_FIELD_IDS,
  REMARKS_PHOTO_FIELD_IDS,
  REMARKS_PHOTO_CAP,
} from "@/lib/multi-photo";

const Q108_ID = "108_additional_photos";
const UNASSIGNED = "UNASSIGNED";
const REVIEWED_FLAG = "__photoAssignmentsReviewed";
const ASSIGNMENT_CONFLICT_ERROR =
  "Job is no longer editable, or its photos or assignments changed. Refresh the job and try again.";

// True ONLY for fields that carry a single-URL legacy mirror at
// formData[fieldId] alongside a map entry in __photoAssignmentsByField.
// Under the locked 2026-04-20 product model, only multi-photo fields
// (Q5/Q16/Q25/Q40/Q71) have this shape. Q108 is map-only (no mirror).
// Remarks-photo owner ids (*_remarks_notes_photos) are map-only too.
// Remarks textarea ids (*_remarks_notes) hold note text, never photos,
// and are not photo owners at all.
//
// Used by stealOneOwner to decide whether a losing-side field's mirror
// needs to be kept consistent when it loses URLs via a steal.
function hasLegacyPhotoMirror(fieldId: string): boolean {
  return MULTI_PHOTO_FIELD_IDS.has(fieldId);
}

// One-photo-one-owner enforcement (locked product rule, 2026-04-20).
// Two-pass steal that covers every current owner locus for a photo:
//
//   Pass 1 — map-backed owners. For every OTHER field with an entry in
//   __photoAssignmentsByField, filter out any URL in the incoming set.
//   When the loser carries a legacy mirror (multi-photo only, per
//   hasLegacyPhotoMirror — remarks owners and Q108 are map-only),
//   also update formData[fid] to the remaining urls[0] so map and
//   mirror stay consistent.
//
//   Pass 2 — legacy mirror-only owners. A URL can also be owned purely
//   via formData[fid] with NO map entry yet — either pre-migration data,
//   a single-slot photo field written by savePhotoAssignments, or a
//   remarks field prior to its dedicated action landing. This pass
//   clears every template photo mirror whose value equals a stolen URL,
//   closing the duplicate-ownership hole Codex flagged on 8088aa3.
//
// Called by assignMultiFieldPhotos and assignAdditionalPhotos just
// before they write their target entry. Q108 is always excluded from
// the Pass 2 mirror sweep (ADDITIONAL_PHOTOS_FIELD_ID has no mirror by
// design), and the target field itself is excluded from both passes
// (the target's entry is written by the caller after this helper).
//
// Mutates `currentMap` and `next` in place — both are local working
// copies built by the caller from the fresh DB read.
function stealOneOwner(
  currentMap: Record<string, unknown>,
  existing: FormData,
  patch: FormData,
  templatePhotoFieldIds: readonly string[],
  targetFieldId: string,
  incomingUrls: string[],
): void {
  if (incomingUrls.length === 0) return;
  const incomingSet = new Set(incomingUrls);

  // Pass 1: map-backed losers. Mirror syncs are written into `patch`
  // (the keys this action will merge), never into a full formData copy —
  // see mergeDraftFormDataPatch for why (ultrareview bug_006).
  for (const [fid, entry] of Object.entries(currentMap)) {
    if (fid === targetFieldId) continue;
    if (!Array.isArray(entry)) continue;
    const original = entry as unknown[];
    let overlaps = false;
    for (const u of original) {
      if (typeof u === "string" && incomingSet.has(u)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) continue;
    const filtered = original.filter(
      (u): u is string => typeof u === "string" && !incomingSet.has(u),
    );
    if (filtered.length === 0) {
      delete currentMap[fid];
    } else {
      currentMap[fid] = filtered;
    }
    if (hasLegacyPhotoMirror(fid)) {
      patch[fid] = filtered[0] ?? "";
    }
  }

  // Pass 2: legacy mirror-only losers.
  // Q108 is NOT skipped here. The post-slice Q108 contract is map-only
  // (assignAdditionalPhotos never writes a mirror), but historical jobs
  // can still carry a stale string at formData["108_additional_photos"]
  // from the pre-slice PhotoFieldInput → RHF → autosave path. Without
  // clearing it, a steal to any other owner would leave the URL owned
  // in two places: the new owner's map entry AND Q108's stale mirror.
  // The target-owner exclusion above is preserved — only the skip for
  // Q108 as a *losing* field is removed.
  // Reads see Pass 1's writes first (patch wins over existing) so a
  // mirror already synced above is never re-evaluated against stale data.
  for (const fid of templatePhotoFieldIds) {
    if (fid === targetFieldId) continue;
    const current = patch[fid] !== undefined ? patch[fid] : existing[fid];
    if (
      typeof current === "string" &&
      current.length > 0 &&
      incomingSet.has(current)
    ) {
      patch[fid] = "";
    }
  }
}

// Atomic single-statement jsonb merge of ONLY the keys an action owns,
// DRAFT-guarded (ultrareview bug_006). Mirrors saveFormData's strategy:
// a concurrent RHF autosave keystroke or saveSummaryItems write can land
// anywhere around this statement and neither side clobbers the other's
// keys. Compare only the ownership map and photo mirrors used to prepare the
// patch: concurrent assignment changes must be retried from a fresh snapshot,
// while unrelated text and summary saves remain independent.
async function mergeDraftFormDataPatch(
  jobId: string,
  patch: FormData,
  expectedPhotos: PhotoMetadata[],
  existing: FormData,
  templatePhotoFieldIds: readonly string[],
): Promise<number> {
  const patchJson = JSON.stringify(patch);
  // An assignment snapshot must not reintroduce a URL removed while this
  // action was preparing its patch. New uploads can still append safely.
  const expectedPhotosJson = JSON.stringify(
    expectedPhotos.map(({ url }) => ({ url })),
  );
  const ownershipKeys = new Set([
    RESERVED_PHOTO_MAP_KEY,
    ...templatePhotoFieldIds,
    // Include mirrors written for a legacy field absent from today's template.
    ...Object.keys(patch).filter((key) => !key.startsWith("__")),
  ]);
  const expectedOwnershipJson = JSON.stringify(
    Object.fromEntries(
      [...ownershipKeys].map((key) => [key, existing[key] ?? null]),
    ),
  );
  return db.$executeRaw`
    UPDATE jobs
    SET form_data = COALESCE(form_data, '{}'::jsonb) || ${patchJson}::jsonb
    WHERE id = ${jobId} AND status::text = 'DRAFT'
      AND COALESCE(photos, '[]'::jsonb) @> ${expectedPhotosJson}::jsonb
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(${expectedOwnershipJson}::jsonb) AS expected(key, value)
        WHERE COALESCE(form_data -> expected.key, 'null'::jsonb)
          IS DISTINCT FROM expected.value
      )
  `;
}

// Payload contract (v1):
//   key   = photo blob URL (stable per upload; legacy data may contain
//           duplicate filenames, so URL is the only reliable identity).
//   value = target field id | "UNASSIGNED" | "108_additional_photos"
//
// Persisted truth on save:
//   formData[<each non-Q108 photo field>] = assigned URL, or "" if unassigned
//   formData["__photoAssignmentsReviewed"] = true
// Q108 and UNASSIGNED are NOT persisted as field mappings — those photos
// drain into Q108 naturally via Pass 3 in generate-pdf.ts.
export type PhotoAssignments = Record<string, string>;

export async function savePhotoAssignments(
  jobId: string,
  assignments: PhotoAssignments,
): Promise<{ success: boolean; error?: string }> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can assign photos" };
  }

  const photos = (job.photos as PhotoMetadata[] | null) ?? [];
  const fields = (job.template?.fields as FormField[] | null) ?? [];
  const existing = (job.formData as FormData | null) ?? {};

  // Map-aware rejection surface. The reserved __photoAssignmentsByField
  // map is the authoritative source for map-backed fields; legacy mirrors
  // are derived. Allowing this action to overwrite a mirror whose field
  // has a map entry would silently split the two shapes (map wins in
  // readFieldPhotoUrls, mirror drifts invisibly). Detection covers:
  //   (a) curated sets — multi-photo + remarks via hasLegacyPhotoMirror
  //   (b) Q108 — map-backed, no mirror (ADDITIONAL_PHOTOS_FIELD_ID)
  //   (c) any field with a current map entry (defensive catch-all)
  const rawMap = existing[RESERVED_PHOTO_MAP_KEY];
  const mapEntries: Record<string, unknown> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? (rawMap as Record<string, unknown>)
      : {};
  const isMapBacked = (id: string) =>
    hasLegacyPhotoMirror(id) ||
    id === ADDITIONAL_PHOTOS_FIELD_ID ||
    REMARKS_PHOTO_FIELD_IDS.has(id) ||
    mapEntries[id] !== undefined;

  // Source-ownership inventory: every URL currently owned by the reserved
  // map, across every field. Used below to reject any incoming assignment
  // whose URL is already map-owned. Without this, a sequence like
  //   assignMultiFieldPhotos(Q5, [u]); savePhotoAssignments({u: "legacy"})
  // would leave map[Q5] AND mirror[legacy] both pointing at u — two owners.
  // savePhotoAssignments is legacy-only and must not touch the map, so the
  // only safe answer is to refuse the write and tell the admin to release
  // map ownership first via the dedicated action.
  const mapOwnedUrls = new Set<string>();
  for (const entry of Object.values(mapEntries)) {
    if (!Array.isArray(entry)) continue;
    for (const u of entry) {
      if (typeof u === "string" && u.length > 0) mapOwnedUrls.add(u);
    }
  }

  // Legacy photo fields: template photo fields (excluding Q108) that are
  // NOT map-backed. Only these are owned by this legacy single-URL path;
  // map-backed fields go through assignMultiFieldPhotos / assignAdditional-
  // Photos and must not be rewritten here.
  const templatePhotoFieldIds = fields
    .filter((f) => f.type === "photo")
    .map((f) => f.id);
  const legacyPhotoFieldIds = templatePhotoFieldIds.filter(
    (id) => id !== Q108_ID && !isMapBacked(id),
  );
  const legacyPhotoFieldSet = new Set(legacyPhotoFieldIds);
  const photoUrlSet = new Set(photos.map((p) => p.url));

  for (const [url, target] of Object.entries(assignments)) {
    if (!photoUrlSet.has(url)) {
      return { success: false, error: "Unknown photo in payload" };
    }
    // UNASSIGNED and Q108 as drain-target produce no legacy mirror write,
    // so they cannot create duplicate ownership via this action — skip both
    // target-side and source-side guards for them.
    if (target === UNASSIGNED || target === Q108_ID) continue;
    if (isMapBacked(target)) {
      return {
        success: false,
        error: `Field ${target} is map-backed; use the dedicated assignment action instead`,
      };
    }
    if (!legacyPhotoFieldSet.has(target)) {
      return { success: false, error: `Unknown assignment target: ${target}` };
    }
    // Source-ownership guard. Atomic: if ANY incoming (url, target) pair
    // fails this check, the whole operation is rejected before the Map
    // invert and mirror rewrite happen. No partial application possible.
    if (mapOwnedUrls.has(url)) {
      return {
        success: false,
        error: `Photo is currently map-owned; release it via the dedicated assignment action before reassigning to ${target}`,
      };
    }
  }

  // Invert: field → url. First assignment wins if UI ever produces a collision.
  const fieldToUrl = new Map<string, string>();
  for (const [url, target] of Object.entries(assignments)) {
    if (target === UNASSIGNED || target === Q108_ID) continue;
    if (fieldToUrl.has(target)) continue;
    fieldToUrl.set(target, url);
  }

  // Deterministic rewrite of ONLY legacy (non-map-backed) photo field
  // mirrors. Map-backed fields — their map entries and their mirrors —
  // stay untouched here, which is what keeps map and mirror consistent.
  const patch: FormData = {};
  for (const fieldId of legacyPhotoFieldIds) {
    patch[fieldId] = fieldToUrl.get(fieldId) ?? "";
  }
  patch[REVIEWED_FLAG] = true;

  const affected = await mergeDraftFormDataPatch(
    jobId,
    patch,
    photos,
    existing,
    templatePhotoFieldIds,
  );
  if (affected === 0) {
    return { success: false, error: ASSIGNMENT_CONFLICT_ERROR };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/admin");
  return { success: true };
}

// Multi-photo slot writer for the 5 numbered fields with buffered per-field
// caps (Q5/Q16/Q25/Q40/Q71). Single-URL fields go through savePhotoAssignments;
// Q108 and remarks fields get their own dedicated actions.
//
// Persisted truth on save:
//   formData["__photoAssignmentsByField"][fieldId] = urls[]  (new shape)
//   formData[fieldId]                              = urls[0] | ""  (legacy mirror)
//   formData["__photoAssignmentsReviewed"]         = true
//
// Per-field cap is the customer source of truth in multi-photo.ts; any cap
// change is a one-line edit there, and the action rejects over-cap payloads
// without silent truncation.
export async function assignMultiFieldPhotos(
  jobId: string,
  fieldId: string,
  urls: string[],
): Promise<{ success: boolean; error?: string }> {
  const cap = getMultiPhotoCap(fieldId);
  if (cap === undefined) {
    return {
      success: false,
      error: `Field ${fieldId} is not a multi-photo target`,
    };
  }

  // De-duplicate while preserving caller-supplied order so the mirror
  // (urls[0]) stays stable across reorders that only shuffle later slots.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string" || u.length === 0) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }

  if (unique.length > cap) {
    return {
      success: false,
      error: `Too many photos for ${fieldId}: ${unique.length} > cap ${cap}`,
    };
  }

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can assign photos" };
  }

  // Ownership: every URL must already exist in job.photos. Prevents a client
  // from binding an arbitrary blob URL to a field.
  const photos = (job.photos as PhotoMetadata[] | null) ?? [];
  const photoUrlSet = new Set(photos.map((p) => p.url));
  for (const u of unique) {
    if (!photoUrlSet.has(u)) {
      return { success: false, error: "Unknown photo in payload" };
    }
  }

  const templateFields = (job.template?.fields as FormField[] | null) ?? [];
  const templatePhotoFieldIds = templateFields
    .filter((f) => f.type === "photo")
    .map((f) => f.id);

  const existing = (job.formData as FormData | null) ?? {};
  const rawMap = existing[RESERVED_PHOTO_MAP_KEY];
  const currentMap: Record<string, unknown> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};

  const patch: FormData = {};

  // One-photo-one-owner: strip incoming URLs from every OTHER map entry
  // AND from every OTHER template photo field's legacy mirror. The mirror
  // sweep closes the legacy-only-owner hole where a URL was previously
  // held via formData[fid] alone (no map entry).
  stealOneOwner(
    currentMap,
    existing,
    patch,
    templatePhotoFieldIds,
    fieldId,
    unique,
  );

  if (unique.length > 0) {
    currentMap[fieldId] = unique;
  } else {
    delete currentMap[fieldId];
  }

  patch[RESERVED_PHOTO_MAP_KEY] = currentMap;
  patch[fieldId] = unique[0] ?? "";
  patch[REVIEWED_FLAG] = true;

  const affected = await mergeDraftFormDataPatch(
    jobId,
    patch,
    photos,
    existing,
    templatePhotoFieldIds,
  );
  if (affected === 0) {
    return { success: false, error: ASSIGNMENT_CONFLICT_ERROR };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/admin");
  return { success: true };
}

// Q108 "Additional Photos" writer — EXPLICIT admin selection, not a drain.
// The savePhotoAssignments action treats Q108 as a tag and never persists
// those photos as a field mapping (they "drain" into Q108 at render time).
// This action, by contrast, writes an explicit list of URLs that the admin
// chose for Q108, capped at ADDITIONAL_PHOTOS_CAP (25 since 2026-07-10).
//
// Persisted truth on save:
//   formData["__photoAssignmentsByField"]["108_additional_photos"] = urls[]
//   formData["__photoAssignmentsReviewed"]                         = true
//
// No legacy mirror into formData["108_additional_photos"]. Q108 has no UI
// that reflects a single URL back to RHF, so mirroring would only give
// autosave a non-`__` key to clobber on the next keystroke. The map entry
// is the single source of truth; readFieldPhotoUrls resolves it by field id.
//
// Cap enforcement is hard: unique.length > cap rejects without silent
// truncation. Ownership is validated against job.photos. Draft-only guard
// is atomic with the write (updateMany with status: "DRAFT"; count === 0
// rejects — the autosave-race fix in saveFormData also protects this key
// from being clobbered by a concurrent autosave).
export async function assignAdditionalPhotos(
  jobId: string,
  urls: string[],
): Promise<{ success: boolean; error?: string }> {
  // De-duplicate while preserving caller-supplied order. Q108 has no
  // single-URL mirror, but order still matters: the admin-chosen sequence
  // is what the PDF will render.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string" || u.length === 0) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }

  if (unique.length > ADDITIONAL_PHOTOS_CAP) {
    return {
      success: false,
      error: `Too many photos for ${ADDITIONAL_PHOTOS_FIELD_ID}: ${unique.length} > cap ${ADDITIONAL_PHOTOS_CAP}`,
    };
  }

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can assign photos" };
  }

  // Ownership: every URL must already exist in job.photos. Q108 is explicit
  // selection from the existing upload pool — not a blob-URL freelist.
  const photos = (job.photos as PhotoMetadata[] | null) ?? [];
  const photoUrlSet = new Set(photos.map((p) => p.url));
  for (const u of unique) {
    if (!photoUrlSet.has(u)) {
      return { success: false, error: "Unknown photo in payload" };
    }
  }

  const templateFields = (job.template?.fields as FormField[] | null) ?? [];
  const templatePhotoFieldIds = templateFields
    .filter((f) => f.type === "photo")
    .map((f) => f.id);

  const existing = (job.formData as FormData | null) ?? {};
  const rawMap = existing[RESERVED_PHOTO_MAP_KEY];
  const currentMap: Record<string, unknown> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};

  const patch: FormData = {};

  // One-photo-one-owner: strip incoming URLs from every OTHER map entry
  // AND from every OTHER template photo field's legacy mirror. Q108 has
  // no mirror (so no self-mirror write), but any stolen URLs still clear
  // from losing-side map entries and from mirror-only owners elsewhere.
  stealOneOwner(
    currentMap,
    existing,
    patch,
    templatePhotoFieldIds,
    ADDITIONAL_PHOTOS_FIELD_ID,
    unique,
  );

  if (unique.length > 0) {
    currentMap[ADDITIONAL_PHOTOS_FIELD_ID] = unique;
  } else {
    delete currentMap[ADDITIONAL_PHOTOS_FIELD_ID];
  }

  patch[RESERVED_PHOTO_MAP_KEY] = currentMap;
  patch[REVIEWED_FLAG] = true;

  const affected = await mergeDraftFormDataPatch(
    jobId,
    patch,
    photos,
    existing,
    templatePhotoFieldIds,
  );
  if (affected === 0) {
    return { success: false, error: ASSIGNMENT_CONFLICT_ERROR };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/admin");
  return { success: true };
}

// Remarks-photo owner writer — dedicated server action for the 8 synthetic
// `*_remarks_notes_photos` owner keys (locked 2026-04-20). Each remarks
// section has both a textarea value at formData["<n>_remarks_notes"] (note
// text, owned by RHF autosave) and a separate map-only photo list at
// __photoAssignmentsByField["<n>_remarks_notes_photos"] (owned by this
// action). The two never collide because the keys differ.
//
// Persisted truth on save:
//   formData["__photoAssignmentsByField"][fieldId] = urls[]  (map-only)
//   formData["__photoAssignmentsReviewed"]         = true
//
// No legacy mirror. Remarks-photo owners have no UI-reflected single-URL
// slot; any mirror would be clobbered by autosave and would also risk
// leaking a photo URL into the textarea note key. The map entry is the
// single source of truth; readFieldPhotoUrls resolves by owner id.
//
// Cap enforcement is hard at REMARKS_PHOTO_CAP (8). Ownership validated
// against job.photos. Draft-only guard is atomic with the write. One-
// photo-one-owner enforced via stealOneOwner.
export async function assignRemarksFieldPhotos(
  jobId: string,
  fieldId: string,
  urls: string[],
): Promise<{ success: boolean; error?: string }> {
  if (!REMARKS_PHOTO_FIELD_IDS.has(fieldId)) {
    return {
      success: false,
      error: `Field ${fieldId} is not a remarks-photo owner id`,
    };
  }

  // De-duplicate while preserving caller-supplied order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const u of urls) {
    if (typeof u !== "string" || u.length === 0) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }

  if (unique.length > REMARKS_PHOTO_CAP) {
    return {
      success: false,
      error: `Too many photos for ${fieldId}: ${unique.length} > cap ${REMARKS_PHOTO_CAP}`,
    };
  }

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can assign photos" };
  }

  // Ownership: every URL must already exist in job.photos.
  const photos = (job.photos as PhotoMetadata[] | null) ?? [];
  const photoUrlSet = new Set(photos.map((p) => p.url));
  for (const u of unique) {
    if (!photoUrlSet.has(u)) {
      return { success: false, error: "Unknown photo in payload" };
    }
  }

  const templateFields = (job.template?.fields as FormField[] | null) ?? [];
  const templatePhotoFieldIds = templateFields
    .filter((f) => f.type === "photo")
    .map((f) => f.id);

  const existing = (job.formData as FormData | null) ?? {};
  const rawMap = existing[RESERVED_PHOTO_MAP_KEY];
  const currentMap: Record<string, unknown> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};

  const patch: FormData = {};

  // One-photo-one-owner: strip incoming URLs from every OTHER map entry
  // AND from every OTHER template photo field's legacy mirror. Since the
  // remarks-photo owner id is NOT in the template (synthetic key), Pass 2
  // of stealOneOwner naturally skips it — no self-mirror write happens.
  stealOneOwner(
    currentMap,
    existing,
    patch,
    templatePhotoFieldIds,
    fieldId,
    unique,
  );

  if (unique.length > 0) {
    currentMap[fieldId] = unique;
  } else {
    delete currentMap[fieldId];
  }

  patch[RESERVED_PHOTO_MAP_KEY] = currentMap;
  // NO mirror write. Remarks-photo is map-only — writing patch[fieldId]
  // would collide with nothing today but would create a synthetic
  // non-`__` key that autosave could clobber.
  patch[REVIEWED_FLAG] = true;

  const affected = await mergeDraftFormDataPatch(
    jobId,
    patch,
    photos,
    existing,
    templatePhotoFieldIds,
  );
  if (affected === 0) {
    return { success: false, error: ASSIGNMENT_CONFLICT_ERROR };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/admin");
  return { success: true };
}
