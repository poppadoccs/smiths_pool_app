"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { FormData } from "@/lib/forms";

export async function saveFormData(jobId: string, formData: FormData) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Job not found");

  await db.job.update({
    where: { id: jobId },
    data: { formData },
  });

  revalidatePath(`/jobs/${jobId}`);
}
