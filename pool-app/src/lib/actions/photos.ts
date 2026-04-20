"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";
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

  const affected = await db.$executeRaw`
    UPDATE jobs
    SET photos = COALESCE(photos, '[]'::jsonb) || ${newPhoto}::jsonb
    WHERE id = ${jobId}
  `;
  if (affected === 0) throw new Error("Job not found");

  revalidatePath(`/jobs/${jobId}`);
}

export async function deletePhoto(jobId: string, photoUrl: string) {
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

  revalidatePath(`/jobs/${jobId}`);
}
