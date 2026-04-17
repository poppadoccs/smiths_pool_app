"use server";

import { db } from "@/lib/db";
import { del } from "@vercel/blob";
import { revalidatePath } from "next/cache";
import type { PhotoMetadata } from "@/lib/photos";

async function getStoredPin(): Promise<string | null> {
  const setting = await db.setting.findUnique({
    where: { key: "admin_pin" },
  });
  return setting?.value ?? process.env.ADMIN_PIN ?? null;
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let match = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) match = false;
  }
  return match;
}

async function checkPin(pin: string): Promise<boolean> {
  const correctPin = await getStoredPin();
  if (!correctPin) return false;
  return constantTimeCompare(pin, correctPin);
}

export async function verifyPin(pin: string): Promise<{ valid: boolean }> {
  return { valid: await checkPin(pin) };
}

export async function getRecipientEmail(): Promise<string> {
  const setting = await db.setting.findUnique({
    where: { key: "recipient_email" },
  });
  return setting?.value || process.env.SUBMISSION_EMAIL || "";
}

export async function saveRecipientEmail(
  pin: string,
  email: string,
): Promise<{ success: boolean; error?: string }> {
  if (!(await checkPin(pin))) {
    return { success: false, error: "Incorrect PIN" };
  }

  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { success: false, error: "Please enter a valid email address" };
  }

  await db.setting.upsert({
    where: { key: "recipient_email" },
    update: { value: trimmed },
    create: { key: "recipient_email", value: trimmed },
  });

  return { success: true };
}

export async function changePin(
  currentPin: string,
  newPin: string,
): Promise<{ success: boolean; error?: string }> {
  if (!(await checkPin(currentPin))) {
    return { success: false, error: "Current PIN is incorrect" };
  }

  const trimmed = newPin.trim();
  if (trimmed.length < 4) {
    return { success: false, error: "New PIN must be at least 4 digits" };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { success: false, error: "PIN must be numbers only" };
  }

  await db.setting.upsert({
    where: { key: "admin_pin" },
    update: { value: trimmed },
    create: { key: "admin_pin", value: trimmed },
  });

  return { success: true };
}

export async function archiveJob(
  pin: string,
  jobId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!(await checkPin(pin))) {
    return { success: false, error: "Incorrect PIN" };
  }

  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return { success: false, error: "Job not found" };
  }
  if (job.status !== "SUBMITTED") {
    return { success: false, error: "Only submitted jobs can be archived" };
  }

  await db.job.update({
    where: { id: jobId },
    data: { status: "ARCHIVED" },
  });

  revalidatePath("/");
  revalidatePath("/admin");
  return { success: true };
}

export async function reopenJob(
  pin: string,
  jobId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!(await checkPin(pin))) {
    return { success: false, error: "Incorrect PIN" };
  }

  // Atomic transition: only flip a currently-SUBMITTED row. Guards against a
  // concurrent archive/delete racing between a read check and the write, and
  // narrows the window where a stale submit-in-progress could be undone.
  const updated = await db.job.updateMany({
    where: { id: jobId, status: "SUBMITTED" },
    data: {
      status: "DRAFT",
      submittedBy: null,
      submittedAt: null,
      workerSignature: null,
    },
  });
  if (updated.count === 0) {
    return { success: false, error: "Only submitted jobs can be reopened" };
  }

  revalidatePath("/");
  revalidatePath("/admin");
  revalidatePath(`/jobs/${jobId}`);
  return { success: true };
}

export async function deleteJob(
  pin: string,
  jobId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!(await checkPin(pin))) {
    return { success: false, error: "Incorrect PIN" };
  }

  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return { success: false, error: "Job not found" };
  }

  // Delete all photos from Vercel Blob storage
  const photos = (job.photos as PhotoMetadata[]) || [];
  const blobDeletes = photos
    .filter((p) => p.url)
    .map((p) => del(p.url).catch(() => {})); // best-effort cleanup
  await Promise.all(blobDeletes);

  // Delete the job from the database
  await db.job.delete({ where: { id: jobId } });

  revalidatePath("/");
  revalidatePath("/admin");
  return { success: true };
}

export async function getSubmittedJobs() {
  return db.job.findMany({
    where: { status: "SUBMITTED" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      jobNumber: true,
      status: true,
      submittedBy: true,
      submittedAt: true,
    },
  });
}

export async function getAllManagedJobs() {
  return db.job.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      jobNumber: true,
      status: true,
      submittedBy: true,
      submittedAt: true,
      workerSignature: true,
    },
  });
}
