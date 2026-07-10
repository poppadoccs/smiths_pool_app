"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { PhotoMetadata } from "@/lib/photos";
import {
  RESERVED_SUMMARY_KEY,
  SUMMARY_PER_ITEM_CAP,
  SUMMARY_PHOTO_TOTAL_CAP,
  SUMMARY_TEXT_MAX_LENGTH,
  type SummaryItem,
} from "@/lib/summary";

// Dedicated writer for formData["__summary_items"] (reserved-key channel —
// see plan 260417-mpf §Reserved keys and src/lib/actions/forms.ts, which
// strips every `__`-prefixed key from autosave payloads so ONLY this action
// can write summary items).
//
// Write strategy mirrors saveFormData's atomic jsonb patch rather than the
// whole-object write used by the photo-assignment actions: summary saves
// fire on a typing debounce, so they race RHF autosave far more often than
// gesture-driven actions do. Patching just the one reserved key means a
// concurrent autosave and a summary save can interleave in any order
// without either clobbering the other's keys.
export async function saveSummaryItems(
  jobId: string,
  items: SummaryItem[],
): Promise<{ success: boolean; error?: string }> {
  // --- Normalize + validate shape strictly (malformed input is a bug
  // signal, not something to coerce) ---
  if (!Array.isArray(items)) {
    return { success: false, error: "Summary items must be an array" };
  }

  const normalized: SummaryItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { success: false, error: "Malformed summary item" };
    }
    const { text, photos } = item as { text?: unknown; photos?: unknown };
    if (typeof text !== "string") {
      return { success: false, error: "Summary item text must be a string" };
    }
    if (text.length > SUMMARY_TEXT_MAX_LENGTH) {
      return {
        success: false,
        error: `Summary item text too long (max ${SUMMARY_TEXT_MAX_LENGTH} characters)`,
      };
    }
    if (
      !Array.isArray(photos) ||
      !photos.every((u) => typeof u === "string" && u.length > 0)
    ) {
      return { success: false, error: "Malformed summary item photos" };
    }
    // De-duplicate photos within the item, preserving order.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const u of photos as string[]) {
      if (seen.has(u)) continue;
      seen.add(u);
      unique.push(u);
    }
    if (unique.length > SUMMARY_PER_ITEM_CAP) {
      return {
        success: false,
        error: `Too many photos on one summary item: ${unique.length} > cap ${SUMMARY_PER_ITEM_CAP}`,
      };
    }
    normalized.push({ text, photos: unique });
  }

  const totalPhotos = normalized.reduce((n, it) => n + it.photos.length, 0);
  if (totalPhotos > SUMMARY_PHOTO_TOTAL_CAP) {
    return {
      success: false,
      error: `Too many summary photos: ${totalPhotos} > cap ${SUMMARY_PHOTO_TOTAL_CAP}`,
    };
  }

  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return { success: false, error: "Job not found" };
  if (job.status !== "DRAFT") {
    return { success: false, error: "Only draft jobs can edit the summary" };
  }

  // Ownership: every referenced photo must already exist on the job.
  const photos = (job.photos as PhotoMetadata[] | null) ?? [];
  const photoUrlSet = new Set(photos.map((p) => p.url));
  for (const item of normalized) {
    for (const u of item.photos) {
      if (!photoUrlSet.has(u)) {
        return { success: false, error: "Unknown photo in summary payload" };
      }
    }
  }

  // Atomic single-key patch, DRAFT-guarded in the same statement. Empty
  // list deletes the key entirely so parseSummaryItems returns null and
  // the legacy blob path takes over again.
  let affected: number;
  if (normalized.length === 0) {
    affected = await db.$executeRaw`
      UPDATE jobs
      SET form_data = COALESCE(form_data, '{}'::jsonb) - ${RESERVED_SUMMARY_KEY}::text
      WHERE id = ${jobId} AND status::text = 'DRAFT'
    `;
  } else {
    const patchJson = JSON.stringify({ [RESERVED_SUMMARY_KEY]: normalized });
    affected = await db.$executeRaw`
      UPDATE jobs
      SET form_data = COALESCE(form_data, '{}'::jsonb) || ${patchJson}::jsonb
      WHERE id = ${jobId} AND status::text = 'DRAFT'
    `;
  }
  if (affected === 0) {
    return { success: false, error: "Job is no longer editable" };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/admin");
  return { success: true };
}
