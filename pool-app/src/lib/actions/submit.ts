"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Resend } from "resend";
import { DEFAULT_TEMPLATE, type FormData, type FormField, type FormTemplate } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { buildSubmissionEmail } from "@/lib/email";
import { getRecipientEmail } from "@/lib/actions/settings";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

export async function submitJob(
  jobId: string,
  submittedBy: string
): Promise<{ success: boolean; error?: string }> {
  // 1. Load job with template
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };

  // 2. Prevent double-submit
  if (job.status === "SUBMITTED") {
    return { success: false, error: "This job has already been submitted" };
  }

  // 3. Validate form data exists
  const formData = job.formData as FormData | null;
  if (!formData) {
    return { success: false, error: "Please fill out the form before submitting" };
  }

  // Resolve template: DB template or fallback to hardcoded default
  const template: FormTemplate = job.template
    ? {
        id: job.template.id,
        name: job.template.name,
        version: 1,
        fields: (job.template.fields as FormField[]).sort(
          (a, b) => a.order - b.order
        ),
      }
    : DEFAULT_TEMPLATE;

  // 4. Check required fields have values
  const requiredFields = template.fields.filter((f) => f.required);
  const missingFields = requiredFields.filter((f) => {
    const value = formData[f.id];
    return value === undefined || value === "" || value === null;
  });
  if (missingFields.length > 0) {
    const names = missingFields.map((f) => f.label).join(", ");
    return { success: false, error: `Missing required fields: ${names}` };
  }

  // 5. Build and send email
  const photos = (job.photos as PhotoMetadata[]) || [];
  const jobTitle = job.name || (job.jobNumber ? `Job #${job.jobNumber}` : `Job ${job.id}`);

  const submissionEmail = await getRecipientEmail();
  if (!submissionEmail) {
    return { success: false, error: "Submission email not configured. Ask the admin to set it in Settings." };
  }

  const html = buildSubmissionEmail({
    jobTitle,
    jobNumber: job.jobNumber,
    submittedBy,
    formData,
    template,
    photos,
  });

  const { error: emailError } = await getResend().emails.send({
    from: "Pool Field Forms <forms@mail.lucacllc.com>",
    to: [submissionEmail],
    subject: `Job Submission: ${jobTitle}`,
    html,
  });

  if (emailError) {
    return { success: false, error: `Email failed: ${emailError.message}` };
  }

  // 6. Lock job as submitted
  await db.job.update({
    where: { id: jobId },
    data: {
      status: "SUBMITTED",
      submittedBy,
      submittedAt: new Date(),
    },
  });

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");

  return { success: true };
}
