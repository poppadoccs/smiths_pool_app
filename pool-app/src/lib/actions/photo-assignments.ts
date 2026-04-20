"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { PhotoMetadata } from "@/lib/photos";
import type { FormData, FormField } from "@/lib/forms";
import { getMultiPhotoCap, RESERVED_PHOTO_MAP_KEY } from "@/lib/multi-photo";

const Q108_ID = "108_additional_photos";
const UNASSIGNED = "UNASSIGNED";
const REVIEWED_FLAG = "__photoAssignmentsReviewed";

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

  if (unique.length > 0) {
    currentMap[fieldId] = unique;
  } else {
    delete currentMap[fieldId];
  }

  const next: FormData = { ...existing };
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
  return { success: true };
}
