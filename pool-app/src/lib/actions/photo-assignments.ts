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
  REMARKS_FIELD_IDS,
} from "@/lib/multi-photo";

const Q108_ID = "108_additional_photos";
const UNASSIGNED = "UNASSIGNED";
const REVIEWED_FLAG = "__photoAssignmentsReviewed";

// True for fields that carry a single-URL legacy mirror at formData[fieldId]
// alongside a map entry in __photoAssignmentsByField. Multi-photo fields and
// remarks fields both carry a mirror that tracks urls[0]; Q108 does NOT have
// a mirror (map-only, by design). Used by stealOneOwner to decide whether a
// losing-side field's mirror needs to be kept consistent.
//
// Keeping this predicate as a single surface means the remarks action (next
// atomic task) inherits correct mirror maintenance without editing stealing
// logic — just extending the action surface.
function hasLegacyPhotoMirror(fieldId: string): boolean {
  return MULTI_PHOTO_FIELD_IDS.has(fieldId) || REMARKS_FIELD_IDS.has(fieldId);
}

// One-photo-one-owner enforcement (locked product rule, 2026-04-20).
// Two-pass steal that covers every current owner locus for a photo:
//
//   Pass 1 — map-backed owners. For every OTHER field with an entry in
//   __photoAssignmentsByField, filter out any URL in the incoming set.
//   When the loser carries a legacy mirror (multi-photo + remarks per
//   hasLegacyPhotoMirror), also update formData[fid] to the remaining
//   urls[0] so map and mirror stay consistent. Q108 is map-only.
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
  next: FormData,
  templatePhotoFieldIds: readonly string[],
  targetFieldId: string,
  incomingUrls: string[],
): void {
  if (incomingUrls.length === 0) return;
  const incomingSet = new Set(incomingUrls);

  // Pass 1: map-backed losers.
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
      next[fid] = filtered[0] ?? "";
    }
  }

  // Pass 2: legacy mirror-only losers.
  for (const fid of templatePhotoFieldIds) {
    if (fid === targetFieldId) continue;
    if (fid === ADDITIONAL_PHOTOS_FIELD_ID) continue;
    const current = next[fid];
    if (
      typeof current === "string" &&
      current.length > 0 &&
      incomingSet.has(current)
    ) {
      next[fid] = "";
    }
  }
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
  const legacyPhotoFieldIds = fields
    .filter((f) => f.type === "photo" && f.id !== Q108_ID)
    .map((f) => f.id)
    .filter((id) => !isMapBacked(id));
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
  const next: FormData = { ...existing };
  for (const fieldId of legacyPhotoFieldIds) {
    next[fieldId] = fieldToUrl.get(fieldId) ?? "";
  }
  next[REVIEWED_FLAG] = true;

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

  const next: FormData = { ...existing };

  // One-photo-one-owner: strip incoming URLs from every OTHER map entry
  // AND from every OTHER template photo field's legacy mirror. The mirror
  // sweep closes the legacy-only-owner hole where a URL was previously
  // held via formData[fid] alone (no map entry).
  stealOneOwner(currentMap, next, templatePhotoFieldIds, fieldId, unique);

  if (unique.length > 0) {
    currentMap[fieldId] = unique;
  } else {
    delete currentMap[fieldId];
  }

  next[RESERVED_PHOTO_MAP_KEY] = currentMap;
  next[fieldId] = unique[0] ?? "";
  next[REVIEWED_FLAG] = true;

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

// Q108 "Additional Photos" writer — EXPLICIT admin selection, not a drain.
// The savePhotoAssignments action treats Q108 as a tag and never persists
// those photos as a field mapping (they "drain" into Q108 at render time).
// This action, by contrast, writes an explicit list of URLs that the admin
// chose for Q108, capped at ADDITIONAL_PHOTOS_CAP (7, locked 2026-04-20).
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

  const next: FormData = { ...existing };

  // One-photo-one-owner: strip incoming URLs from every OTHER map entry
  // AND from every OTHER template photo field's legacy mirror. Q108 has
  // no mirror (so no self-mirror write), but any stolen URLs still clear
  // from losing-side map entries and from mirror-only owners elsewhere.
  stealOneOwner(
    currentMap,
    next,
    templatePhotoFieldIds,
    ADDITIONAL_PHOTOS_FIELD_ID,
    unique,
  );

  if (unique.length > 0) {
    currentMap[ADDITIONAL_PHOTOS_FIELD_ID] = unique;
  } else {
    delete currentMap[ADDITIONAL_PHOTOS_FIELD_ID];
  }

  next[RESERVED_PHOTO_MAP_KEY] = currentMap;
  next[REVIEWED_FLAG] = true;

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
