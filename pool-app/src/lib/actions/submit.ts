"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Resend } from "resend";
import {
  DEFAULT_TEMPLATE,
  type FormData,
  type FormField,
  type FormTemplate,
} from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { buildSubmissionEmail } from "@/lib/email";
import { getRecipientEmail } from "@/lib/actions/settings";
import { generateJobPdf } from "@/lib/actions/generate-pdf";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

const MAX_SIGNATURE_BYTES = 200_000; // ~200KB decoded — generous for a drawn signature

function validateSignature(sig: string): string | null {
  if (!sig.startsWith("data:image/png;base64,")) {
    return "Signature must be a PNG data URL";
  }
  const b64 = sig.slice("data:image/png;base64,".length);
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length > MAX_SIGNATURE_BYTES) {
    return `Signature too large (${(decoded.length / 1024).toFixed(0)}KB, max ${MAX_SIGNATURE_BYTES / 1000}KB)`;
  }
  return null;
}

export async function submitJob(
  jobId: string,
  submittedBy: string,
  workerSignature?: string,
): Promise<{
  success: boolean;
  error?: string;
  // Present only on the success return so the UI can distinguish a clean
  // happy-path submission from a "job saved but office email didn't send"
  // state. Error returns do not set this field.
  emailSent?: boolean;
}> {
  // 0. Validate signature format + size
  if (workerSignature) {
    const sigError = validateSignature(workerSignature);
    if (sigError) return { success: false, error: sigError };
  }

  // 1. Load job with template
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };

  // 2. Prevent double-submit (read check for fast-path UX feedback only;
  //    the atomic updateMany below is the real guard against concurrent submits)
  if (job.status === "SUBMITTED") {
    return { success: false, error: "This job has already been submitted" };
  }

  // 3. Validate form data exists
  const formData = job.formData as FormData | null;
  if (!formData) {
    return {
      success: false,
      error: "Please fill out the form before submitting",
    };
  }

  // Structural integrity: verify expected field IDs are present
  const tplFields = job.template
    ? (job.template.fields as { id: string }[])
    : [];
  const payloadKeys = new Set(Object.keys(formData));
  const missingIds = tplFields
    .map((f) => f.id)
    .filter((id) => !payloadKeys.has(id));

  console.log(
    `[submit] Job ${jobId}: ${payloadKeys.size} keys, template expects ${tplFields.length}, missing ${missingIds.length}`,
  );
  if (tplFields.length >= 20 && missingIds.length > tplFields.length * 0.5) {
    return {
      success: false,
      error: `Data integrity error: ${missingIds.length} of ${tplFields.length} fields are missing. The form may not have loaded correctly — go back and try again.`,
    };
  }

  // Resolve template: DB template or fallback to hardcoded default
  const template: FormTemplate = job.template
    ? {
        id: job.template.id,
        name: job.template.name,
        version: 1,
        fields: (job.template.fields as FormField[]).sort(
          (a, b) => a.order - b.order,
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

  // 5. Preflight — verify email configured before committing anything
  const photos = (job.photos as PhotoMetadata[]) || [];
  const jobTitle =
    job.name || (job.jobNumber ? `Job #${job.jobNumber}` : `Job ${job.id}`);

  const submissionEmail = await getRecipientEmail();
  if (!submissionEmail) {
    return {
      success: false,
      error:
        "Submission email not configured. Ask the admin to set it in Settings.",
    };
  }

  // 6. Atomic DB write — updateMany with status guard prevents concurrent double-submits
  const updated = await db.job.updateMany({
    where: { id: jobId, status: { not: "SUBMITTED" } },
    data: {
      status: "SUBMITTED",
      submittedBy,
      submittedAt: new Date(),
      workerSignature: workerSignature || null,
    },
  });
  if (updated.count === 0) {
    return { success: false, error: "This job has already been submitted" };
  }

  // 7. Generate branded PDF (non-blocking — email still sends if PDF fails)
  // jsPDF datauristring emits: data:application/pdf;filename=generated.pdf;base64,<data>
  // Use a match to safely extract just the base64 payload.
  type PdfAttachment = {
    filename: string;
    content: string;
    contentType: string;
  };
  let pdfAttachment: PdfAttachment | undefined;
  try {
    const safeFilename =
      jobTitle.replace(/[^a-z0-9]/gi, "-").toLowerCase() || "report";
    const pdfResult = await generateJobPdf(jobId);
    if (pdfResult.success && pdfResult.data) {
      const match = pdfResult.data.match(
        /^data:application\/pdf(?:;[^,]*)?;base64,(.+)$/,
      );
      if (match) {
        pdfAttachment = {
          filename: `${safeFilename}-report.pdf`,
          content: match[1],
          contentType: "application/pdf",
        };
      } else {
        console.error(
          "[submit] PDF data URI format unexpected, skipping attachment",
        );
      }
    }
  } catch (err) {
    console.error(
      "[submit] PDF generation failed, sending without attachment:",
      err,
    );
  }

  // 8. Build and send email with PDF attached.
  // Base URL for the "Open editable version" link. We deliberately do
  // NOT fall back to a localhost default in production — a forgotten
  // env var would otherwise ship a working-looking button that opens
  // nothing in the office's browser. Skip the link instead;
  // buildSubmissionEmail omits the whole CTA block when editUrl is
  // undefined.
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
  const editUrl = appBaseUrl
    ? `${appBaseUrl.replace(/\/+$/, "")}/jobs/${jobId}`
    : undefined;

  const html = buildSubmissionEmail({
    jobTitle,
    jobNumber: job.jobNumber,
    submittedBy,
    formData,
    template,
    photos,
    editUrl,
  });

  // Two failure modes the worker must see as "saved-but-unsent":
  //  1) Resend returns { error } — relay/SMTP issue surfaced via the SDK
  //  2) Resend throws / rejects — network or SDK-internal failure
  // Both resolve to emailSent: false. Raw error details stay in stderr only.
  let emailSent = true;
  try {
    const { error: emailError } = await getResend().emails.send({
      from: "Pool Field Forms <forms@mail.lucacllc.com>",
      to: [submissionEmail],
      subject: `Job Submission: ${jobTitle}`,
      html,
      ...(pdfAttachment ? { attachments: [pdfAttachment] } : {}),
    });
    if (emailError) {
      console.error(
        `[submit] Email failed after job ${jobId} committed:`,
        emailError.message,
      );
      emailSent = false;
    }
  } catch (err) {
    console.error(
      `[submit] Email send threw after job ${jobId} committed:`,
      err,
    );
    emailSent = false;
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/");

  return { success: true, emailSent };
}
