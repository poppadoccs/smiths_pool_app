"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { del } from "@vercel/blob";
import type { PhotoMetadata } from "@/lib/photos";

export async function savePhotoMetadata(
  jobId: string,
  photo: { url: string; filename: string; size: number }
) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const photos = (job.photos as PhotoMetadata[]) || [];
  photos.push({
    url: photo.url,
    filename: photo.filename,
    size: photo.size,
    uploadedAt: new Date().toISOString(),
  });

  await db.job.update({
    where: { id: jobId },
    data: { photos },
  });

  revalidatePath(`/jobs/${jobId}`);
}

export async function deletePhoto(jobId: string, photoUrl: string) {
  // Delete from Vercel Blob storage (per PHOT-04)
  await del(photoUrl);

  // Remove from database
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  const photos = (job.photos as PhotoMetadata[]) || [];
  const filtered = photos.filter((p) => p.url !== photoUrl);

  await db.job.update({
    where: { id: jobId },
    data: { photos: filtered },
  });

  revalidatePath(`/jobs/${jobId}`);
}
