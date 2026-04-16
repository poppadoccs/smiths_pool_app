"use server";

import { db } from "@/lib/db";
import { jsPDF } from "jspdf";
import {
  DEFAULT_TEMPLATE,
  type FormData,
  type FormField,
  type FormTemplate,
} from "@/lib/forms";
import { readFileSync } from "fs";
import { join } from "path";

const COMPANY_NAME = "Poolsmith's Renovations LLC";
const COMPANY_PHONE = "407-223-5379";
const COMPANY_EMAIL = "poolsmithsrenovations@gmail.com";
const COMPANY_LICENSE = "License CPC1459862";

const PAGE_WIDTH = 210; // A4 mm
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

export async function generateJobPdf(
  jobId: string,
): Promise<{ success: boolean; data?: string; error?: string }> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) return { success: false, error: "Job not found" };

  const formData = job.formData as FormData | null;
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

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  // --- Header: Company branding ---
  // Try to embed the real PoolSmiths logo; fall back to text if unavailable.
  const LOGO_W = 50; // mm
  const LOGO_H = 40; // mm — matches 1280×1024 aspect (1.25:1)
  try {
    const logoPath = join(process.cwd(), "public", "poolsmiths-logo.png");
    const logoData = readFileSync(logoPath).toString("base64");
    const logoX = (PAGE_WIDTH - LOGO_W) / 2;
    doc.addImage(logoData, "PNG", logoX, y, LOGO_W, LOGO_H);
    y += LOGO_H + 3;
  } catch {
    // Logo not found — render text fallback
    doc.setFontSize(18);
    doc.setFont("helvetica", "bold");
    doc.text(COMPANY_NAME, PAGE_WIDTH / 2, y, { align: "center" });
    y += 7;
  }

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(
    `${COMPANY_PHONE}  |  ${COMPANY_EMAIL}  |  ${COMPANY_LICENSE}`,
    PAGE_WIDTH / 2,
    y,
    { align: "center" },
  );
  y += 4;

  // Divider line
  doc.setDrawColor(0);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 5;

  // --- Liability disclaimer (matches printed inspection form) ---
  const disclaimer1 =
    "This inspection is for observed condition on the date & time of the inspection only. " +
    "There are NO warranties or guarantees beyond this inspection, as to the longevity of items inspected.";
  const disclaimer2 =
    "Only visible leaks are noted such as pump seal or filter housing. " +
    "This inspection does not imply that the pool or pool/spa is not leaking or that " +
    "if there is a visible leak that it is the only leak.";

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  const d1Lines = doc.splitTextToSize(disclaimer1, CONTENT_WIDTH);
  doc.text(d1Lines, MARGIN, y);
  y += d1Lines.length * 3.5;

  doc.setFont("helvetica", "normal");
  const d2Lines = doc.splitTextToSize(disclaimer2, CONTENT_WIDTH);
  doc.text(d2Lines, MARGIN, y);
  y += d2Lines.length * 3.5 + 4;

  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 6;

  // --- Job title ---
  const jobTitle =
    job.name || (job.jobNumber ? `Job #${job.jobNumber}` : `Job ${job.id}`);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text(jobTitle, MARGIN, y);
  y += 6;

  if (job.submittedBy || job.submittedAt) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    const parts: string[] = [];
    if (job.submittedBy) parts.push(`Submitted by: ${job.submittedBy}`);
    if (job.submittedAt)
      parts.push(`Date: ${job.submittedAt.toLocaleDateString()}`);
    doc.text(parts.join("  |  "), MARGIN, y);
    y += 8;
  }

  // --- Form fields ---
  doc.setFontSize(10);
  let currentSection = "";

  for (const field of template.fields) {
    // Section header
    if (field.section && field.section !== currentSection) {
      currentSection = field.section;
      y += 3;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(field.section, MARGIN, y);
      y += 1;
      doc.setLineWidth(0.2);
      doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
      y += 5;
    }

    // Field label + value
    const rawValue = formData?.[field.id];
    let displayValue: string;
    if (field.type === "checkbox") {
      displayValue = rawValue ? "Yes" : "No";
    } else if (field.type === "photo") {
      displayValue = rawValue ? "(photo attached)" : "—";
    } else if (typeof rawValue === "string" && rawValue.trim()) {
      displayValue = rawValue;
    } else {
      displayValue = "—";
    }

    const label = field.label.replace(/^\d+\.\s*/, ""); // strip numbering for cleaner PDF
    const labelWidth = 80;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);

    // Pre-measure wrapped text to check page break BEFORE drawing
    const labelLines = doc.splitTextToSize(label, labelWidth);
    doc.setFont("helvetica", "normal");
    const valueLines = doc.splitTextToSize(
      displayValue,
      CONTENT_WIDTH - labelWidth - 5,
    );
    const blockHeight = Math.max(labelLines.length, valueLines.length) * 4 + 2;

    if (y + blockHeight > 280) {
      doc.addPage();
      y = MARGIN;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(labelLines, MARGIN, y);

    doc.setFont("helvetica", "normal");
    doc.text(valueLines, MARGIN + labelWidth + 5, y);

    y += blockHeight;
  }

  // --- Worker Signature ---
  if (job.workerSignature) {
    if (y > 230) {
      doc.addPage();
      y = MARGIN;
    }

    y += 5;
    doc.setLineWidth(0.3);
    doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
    y += 8;

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Worker Signature", MARGIN, y);
    y += 6;

    try {
      // signature_pad outputs a data:image/png;base64,... string
      doc.addImage(job.workerSignature, "PNG", MARGIN, y, 60, 25);
      y += 28;
    } catch {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.text("(signature image could not be rendered)", MARGIN, y);
      y += 5;
    }

    if (job.submittedBy) {
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.text(job.submittedBy, MARGIN, y);
      y += 4;
    }
    if (job.submittedAt) {
      doc.text(job.submittedAt.toLocaleDateString(), MARGIN, y);
    }
  }

  // Return as base64 string (client converts to Blob for download)
  const pdfBase64 = doc.output("datauristring");
  return { success: true, data: pdfBase64 };
}
