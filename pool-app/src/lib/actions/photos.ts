"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";
import { buildPhotoRemovalPatch, isEditableCopy } from "@/lib/multi-photo";
import type { PhotoMetadata } from "@/lib/photos";
import type { FormField } from "@/lib/forms";

// Editable copies can change their own include flags without changing shared
// blobs. Both the early check and the UPDATE require a DRAFT job; the UPDATE
// also protects against submission or archival after the early read.
//
// SQL strategy: rebuild the photos array atomically. For the matching
// URL, jsonb_set writes `includedInPdf`; every sibling object is passed
// through unchanged, preserving any other fields. Order is preserved via
// WITH ORDINALITY so existing render order is stable.
export async function setPhotoIncludedInPdf(
  jobId: string,
  photoUrl: string,
  included: boolean,
) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!job) throw new Error("Job not found");
  if (job.status !== "DRAFT") {
    throw new Error(
      `Cannot change photo PDF inclusion on a ${job.status.toLowerCase()} job`,
    );
  }

  // Stringify so Prisma can interpolate as a parameterized JSONB literal.
  const includedJson = JSON.stringify(included);
  const affected = await db.$executeRaw`
    UPDATE jobs
    SET photos = (
      SELECT COALESCE(jsonb_agg(
        CASE
          WHEN elem->>'url' = ${photoUrl}
            THEN jsonb_set(elem, '{includedInPdf}', ${includedJson}::jsonb)
          ELSE elem
        END
        ORDER BY ordinality
      ), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(photos, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ordinality)
    )
    WHERE id = ${jobId} AND status::text = 'DRAFT'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(photos, '[]'::jsonb)) AS photo
        WHERE photo->>'url' = ${photoUrl}
      )
  `;
  if (affected === 0) {
    throw new Error("Job not found, photo not found, or no longer editable");
  }

  revalidatePath(`/jobs/${jobId}`);
}

export async function deletePhoto(
  jobId: string,
  photoUrl: string,
): Promise<{ success: true; blobCleanupPending: boolean }> {
  // Lock before reading the mutable JSON. A concurrent summary save either
  // commits first and appears in this snapshot, or waits until this removal
  // commits. Metadata and all references leave the job in the same write.
  await db.$transaction(async (tx) => {
    const [job] = await tx.$queryRaw<
      {
        status: string;
        photos: PhotoMetadata[] | null;
        formData: Record<string, unknown> | null;
        templateFields: FormField[] | null;
      }[]
    >`
      SELECT j.status::text AS status, j.photos, j.form_data AS "formData",
        t.fields AS "templateFields"
      FROM jobs j
      LEFT JOIN form_templates t ON t.id = j.template_id
      WHERE j.id = ${jobId}
      FOR UPDATE OF j
    `;
    if (!job) throw new Error("Job not found");
    if (job.status !== "DRAFT") {
      throw new Error(
        `Cannot delete photos from a ${job.status.toLowerCase()} job`,
      );
    }
    if (isEditableCopy(job.formData)) {
      throw new Error("Cannot delete photos from an editable copy");
    }

    const photos = Array.isArray(job.photos) ? job.photos : [];
    if (!photos.some((photo) => photo.url === photoUrl)) {
      throw new Error("Photo does not belong to this job");
    }

    const photoFieldIds = Array.isArray(job.templateFields)
      ? job.templateFields.filter((f) => f.type === "photo").map((f) => f.id)
      : [];
    const patch = buildPhotoRemovalPatch(job.formData, photoUrl, photoFieldIds);
    const updated = await tx.job.updateMany({
      where: { id: jobId, status: "DRAFT" },
      data: {
        photos: photos.filter((photo) => photo.url !== photoUrl),
        ...(patch && { formData: { ...job.formData, ...patch } as object }),
      },
    });
    if (updated.count === 0) throw new Error("Job is no longer editable");
  });

  // Never hold a database lock across Blob requests. Failed cleanup leaves an
  // unreferenced blob, not a broken job or a stale snapshot restored over edits.
  // Report the partial cleanup explicitly so the caller can show accurate UI.
  let blobCleanupPending = false;
  try {
    await del(photoUrl);
  } catch {
    blobCleanupPending = true;
    console.warn(
      `[deletePhoto] Job ${jobId}: photo removed; Blob cleanup failed`,
    );
  }

  revalidatePath(`/jobs/${jobId}`);
  return { success: true, blobCleanupPending };
}
