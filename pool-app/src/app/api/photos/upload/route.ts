import { del, put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { PhotoMetadata } from "@/lib/photos";

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid upload request" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  const jobId = formData.get("jobId");
  const originalFilename = formData.get("originalFilename");
  if (
    typeof jobId !== "string" ||
    !jobId.trim() ||
    jobId.length > 128 ||
    typeof originalFilename !== "string" ||
    !originalFilename.trim() ||
    originalFilename.length > 255 ||
    !(file instanceof File) ||
    file.size === 0 ||
    !PHOTO_CONTENT_TYPES.has(file.type)
  ) {
    return NextResponse.json(
      {
        error:
          "A job, original filename, and JPEG, PNG, or WebP photo are required",
      },
      { status: 400 },
    );
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json(
      { error: "Photo must be no larger than 4 MB" },
      { status: 413 },
    );
  }

  try {
    // Reject invalid destinations before creating a Blob. The status check
    // is repeated atomically below because submission can finish during put().
    const job = await db.job.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if (job.status !== "DRAFT") {
      return NextResponse.json(
        { error: "Job is no longer editable" },
        { status: 409 },
      );
    }

    const blob = await put(
      originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_"),
      file,
      {
        access: "public",
        addRandomSuffix: true,
        contentType: file.type,
      },
    );
    // Registration belongs to this server-owned upload operation. No client
    // URL, size, or timestamp can be used to claim an existing job's Blob.
    const photo: PhotoMetadata = {
      url: blob.url,
      filename: originalFilename,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    };
    const photoJson = JSON.stringify([photo]);
    const affected = await db.$executeRaw`
      UPDATE jobs
      SET photos = COALESCE(photos, '[]'::jsonb) || ${photoJson}::jsonb
      WHERE id = ${jobId} AND status::text = 'DRAFT'
    `;
    if (affected === 0) {
      // A definite rejection proves this newly created Blob was not attached.
      // Never do this in the catch below: a DB error can follow a committed write.
      try {
        await del(blob.url);
      } catch {
        console.error("[upload-route] Could not clean up a rejected upload");
      }
      return NextResponse.json(
        { error: "Job is no longer editable" },
        { status: 409 },
      );
    }

    revalidatePath(`/jobs/${jobId}`);
    return NextResponse.json(photo);
  } catch {
    console.error("[upload-route] Photo upload or registration failed");
    return NextResponse.json(
      { error: "Could not save the photo. Refresh the job before retrying." },
      { status: 500 },
    );
  }
}
