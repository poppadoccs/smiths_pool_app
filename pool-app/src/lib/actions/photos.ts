"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";
import { buildPhotoRemovalPatch, isEditableCopy } from "@/lib/multi-photo";
export async function savePhotoMetadata(
  jobId: string,
  photo: { url: string; filename: string; size: number },
) {
  const newPhoto = JSON.stringify([
    {
      url: photo.url,
      filename: photo.filename,
      size: photo.size,
      uploadedAt: new Date().toISOString(),
    },
  ]);

  // DRAFT-only, atomic with the write (ultrareview bug_001): the upload
  // pipeline (compress → blob upload → this action) spans seconds, so a
  // submit can land mid-flight; without the status filter the photo would
  // append to a SUBMITTED job the office already received.
  const affected = await db.$executeRaw`
    UPDATE jobs
    SET photos = COALESCE(photos, '[]'::jsonb) || ${newPhoto}::jsonb
    WHERE id = ${jobId} AND status::text = 'DRAFT'
  `;
  if (affected === 0) throw new Error("Job not found or no longer editable");

  revalidatePath(`/jobs/${jobId}`);
}

// Toggle a photo's PDF-include flag. Mirrors deletePhoto's guards:
// SUBMITTED jobs are terminal and editable copies share blobs with the
// source. Editable copies CAN flip the include flag (it lives in the
// copy's own job.photos JSON, not the shared blob), but we still block
// SUBMITTED to keep the post-submit edit path going through createEditableCopy.
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
  if (job.status === "SUBMITTED") {
    throw new Error("Cannot change photo PDF inclusion on a submitted job");
  }

  // Stringify so Prisma can interpolate as a parameterized JSONB literal,
  // matching the savePhotoMetadata pattern.
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
    WHERE id = ${jobId}
  `;
  if (affected === 0) throw new Error("Job not found");

  revalidatePath(`/jobs/${jobId}`);
}

export async function deletePhoto(jobId: string, photoUrl: string) {
  // Server-side guards mirroring the UI read-only intent. UI hides the
  // delete button on SUBMITTED jobs and on editable copies, but the
  // action is reachable directly — re-check here before either
  // destructive op. SUBMITTED is terminal (submitJob's atomic flip
  // never reverses it) and __sourceJobId is set at copy creation and
  // never cleared, so the read-then-check window has no real race for
  // these specific invariants.
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      formData: true,
      template: { select: { fields: true } },
    },
  });
  if (!job) throw new Error("Job not found");
  if (job.status === "SUBMITTED") {
    throw new Error("Cannot delete photos from a submitted job");
  }
  if (isEditableCopy(job.formData as Record<string, unknown> | null)) {
    throw new Error("Cannot delete photos from an editable copy");
  }

  // Not fully atomic: Blob is deleted before the DB update. If the DB update
  // fails after del(), the blob is gone but the metadata remains. Acceptable
  // for now — a follow-up can wrap this in a compensating cleanup if needed.
  await del(photoUrl);

  const affected = await db.$executeRaw`
    UPDATE jobs
    SET photos = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(photos, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ordinality)
      WHERE elem->>'url' != ${photoUrl}
    )
    WHERE id = ${jobId}
  `;
  if (affected === 0) throw new Error("Job not found");

  // Strip every formData reference to the deleted URL (ultrareview
  // bug_002): assignment-map buckets, legacy field mirrors, and summary
  // bullets. Without this the ghost URL re-enters the PDF via Pass 1's
  // external-URL branch and prints "[photo could not be loaded]" forever.
  // Written as a DRAFT-guarded jsonb merge of only the changed keys, so
  // concurrent autosave text writes are untouched.
  const photoFieldIds = Array.isArray(job.template?.fields)
    ? (job.template.fields as { id: string; type: string }[])
        .filter((f) => f.type === "photo")
        .map((f) => f.id)
    : [];
  const patch = buildPhotoRemovalPatch(
    job.formData as Record<string, unknown> | null,
    photoUrl,
    photoFieldIds,
  );
  if (patch) {
    const patchJson = JSON.stringify(patch);
    await db.$executeRaw`
      UPDATE jobs
      SET form_data = COALESCE(form_data, '{}'::jsonb) || ${patchJson}::jsonb
      WHERE id = ${jobId} AND status::text = 'DRAFT'
    `;
  }

  revalidatePath(`/jobs/${jobId}`);
}
