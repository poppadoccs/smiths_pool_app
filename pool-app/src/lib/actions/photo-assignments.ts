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
} from "@/lib/multi-photo";

const Q108_ID = "108_additional_photos";
const UNASSIGNED = "UNASSIGNED";
const REVIEWED_FLAG = "__photoAssignmentsReviewed";

// One-photo-one-owner enforcement (locked product rule, 2026-04-20).
// Removes every URL in `incomingUrls` from OTHER field entries in the
// shared __photoAssignmentsByField map, and keeps the legacy single-URL
// mirror consistent for multi-photo fields that lose a URL.
//
// Called by assignMultiFieldPhotos and assignAdditionalPhotos just before
// they write their target field's new entry. Q108 has no legacy mirror
// (by design), so when Q108 is the loser only the map is updated.
//
// Mutates `currentMap` and `next` in place — both are local working
// copies built by the caller from the fresh DB read.
function stealOneOwner(
  currentMap: Record<string, unknown>,
  next: FormData,
  targetFieldId: string,
  incomingUrls: string[],
): void {
  if (incomingUrls.length === 0) return;
  const incomingSet = new Set(incomingUrls);
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
    // Multi-photo fields mirror urls[0] into formData[fieldId]; keep the
    // mirror consistent with the post-steal list. Q108 has no mirror.
    if (getMultiPhotoCap(fid) !== undefined) {
      next[fid] = filtered[0] ?? "";
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
  const photoFieldIds = fields
    .filter((f) => f.type === "photo" && f.id !== Q108_ID)
    .map((f) => f.id);
  const photoFieldSet = new Set(photoFieldIds);
  const photoUrlSet = new Set(photos.map((p) => p.url));

  for (const [url, target] of Object.entries(assignments)) {
    if (!photoUrlSet.has(url)) {
      return { success: false, error: "Unknown photo in payload" };
    }
    if (
      target !== UNASSIGNED &&
      target !== Q108_ID &&
      !photoFieldSet.has(target)
    ) {
      return { success: false, error: `Unknown assignment target: ${target}` };
    }
  }

  // Invert: field → url. First assignment wins if UI ever produces a collision.
  const fieldToUrl = new Map<string, string>();
  for (const [url, target] of Object.entries(assignments)) {
    if (target === UNASSIGNED || target === Q108_ID) continue;
    if (fieldToUrl.has(target)) continue;
    fieldToUrl.set(target, url);
  }

  // Deterministic rewrite: every non-Q108 photo field gets the chosen URL or "".
  // Preserves non-photo formData entries untouched.
  const existing = (job.formData as FormData | null) ?? {};
  const next: FormData = { ...existing };
  for (const fieldId of photoFieldIds) {
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

  const job = await db.job.findUnique({ where: { id: jobId } });
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

  const existing = (job.formData as FormData | null) ?? {};
  const rawMap = existing[RESERVED_PHOTO_MAP_KEY];
  const currentMap: Record<string, unknown> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};

  const next: FormData = { ...existing };

  // One-photo-one-owner: remove incoming URLs from every OTHER field's
  // map entry (multi-photo losers also get their legacy mirror cleared to
  // the remaining urls[0] so map and mirror stay consistent).
  stealOneOwner(currentMap, next, fieldId, unique);

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

  const job = await db.job.findUnique({ where: { id: jobId } });
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

  const existing = (job.formData as FormData | null) ?? {};
  const rawMap = existing[RESERVED_PHOTO_MAP_KEY];
  const currentMap: Record<string, unknown> =
    rawMap && typeof rawMap === "object" && !Array.isArray(rawMap)
      ? { ...(rawMap as Record<string, unknown>) }
      : {};

  const next: FormData = { ...existing };

  // One-photo-one-owner: remove incoming URLs from every OTHER field's
  // map entry. Multi-photo losers get their legacy mirror cleared to the
  // remaining urls[0]; Q108 has no mirror.
  stealOneOwner(currentMap, next, ADDITIONAL_PHOTOS_FIELD_ID, unique);

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
