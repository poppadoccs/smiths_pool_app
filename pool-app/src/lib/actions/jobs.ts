"use server";

import { db } from "@/lib/db";
import { createJobSchema } from "@/lib/validations/job";
import { revalidatePath } from "next/cache";

export async function createJob(prevState: unknown, formData: FormData) {
  const rawName = formData.get("name");
  const rawJobNumber = formData.get("jobNumber");

  const parsed = createJobSchema.safeParse({
    name: typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined,
    jobNumber: typeof rawJobNumber === "string" && rawJobNumber.trim() ? rawJobNumber.trim() : undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.flatten().formErrors.join(", ") };
  }

  const rawTemplateId = formData.get("templateId");
  const templateId = typeof rawTemplateId === "string" && rawTemplateId.trim()
    ? rawTemplateId.trim()
    : null;

  await db.job.create({
    data: {
      name: parsed.data.name ?? null,
      jobNumber: parsed.data.jobNumber ?? null,
      status: "DRAFT",
      ...(templateId && { templateId }),
    },
  });

  revalidatePath("/");
  return { success: true };
}
