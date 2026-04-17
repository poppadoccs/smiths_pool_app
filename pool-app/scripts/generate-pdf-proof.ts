/**
 * Generates a proof PDF for the Kimberly Hennessy job and writes it to the
 * Windows Downloads folder for client review.
 *
 * Usage: cd pool-app && npx tsx scripts/generate-pdf-proof.ts
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "path";
loadEnvConfig(resolve(__dirname, ".."));

import { readFileSync, writeFileSync } from "fs";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaNeon } from "@prisma/adapter-neon";
import { jsPDF } from "jspdf";

// ---------------------------------------------------------------------------
// Types (inlined — avoids @/ path alias resolution in tsx)
// ---------------------------------------------------------------------------
interface FormField {
  id: string;
  label: string;
  type: string;
  order: number;
  section?: string;
  options?: string[];
  required?: boolean;
}

interface PhotoMetadata {
  url: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Constants (must match generate-pdf.ts)
// ---------------------------------------------------------------------------
const COMPANY_NAME = "Poolsmith's Renovations LLC";
const COMPANY_PHONE = "407-223-5379";
const COMPANY_EMAIL = "poolsmithsrenovations@gmail.com";
const COMPANY_LICENSE = "License CPC1459862";

const PAGE_WIDTH = 210;
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const OUTPUT_PATH =
  "C:\\Users\\renea\\Downloads\\Kimberly Hennessy-report (2).pdf";

// Fits an image inside a balanced box so portrait and landscape photos feel
// consistent — landscape never fills the full content width, portrait never
// shrinks below a readable minimum. Aspect ratio always preserved.
// MUST stay identical to fitPhoto in src/lib/actions/generate-pdf.ts.
function fitPhoto(props: { width: number; height: number }): {
  imgW: number;
  imgH: number;
} {
  const MAX_W = 130; // mm — keeps landscape from dominating the page
  const MAX_H = 95; // mm — allows slightly taller portraits than the old 75
  const MIN_W = 70; // mm — prevents tall portraits from becoming slivers
  const ar = props.height / props.width; // >1 = portrait, <1 = landscape

  let imgW = MAX_W;
  let imgH = ar * imgW;
  if (imgH > MAX_H) {
    imgH = MAX_H;
    imgW = imgH / ar;
  }
  // Only apply MIN_W when widening won't push height back over MAX_H.
  if (imgW < MIN_W && ar * MIN_W <= MAX_H) {
    imgW = MIN_W;
    imgH = ar * imgW;
  }
  return { imgW, imgH };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const db = new PrismaClient({ adapter });

  try {
    // Find the most recent Kimberly Hennessy job
    const job = await db.job.findFirst({
      where: {
        OR: [
          { name: { contains: "Kimberly", mode: "insensitive" } },
          { name: { contains: "Hennessy", mode: "insensitive" } },
        ],
      },
      include: { template: true },
      orderBy: { createdAt: "desc" },
    });

    if (!job) {
      console.error(
        'No job matching "Kimberly" or "Hennessy" found. Check job names in DB.',
      );
      process.exit(1);
    }

    console.log(`Generating PDF for job: "${job.name}" (${job.id})`);

    const formData = job.formData as Record<string, unknown> | null;
    const fields: FormField[] = (
      (job.template?.fields as unknown as FormField[]) ?? []
    ).sort((a, b) => a.order - b.order);

    const doc = new jsPDF({ unit: "mm", format: "a4" });
    let y = MARGIN;

    // -------------------------------------------------------------------------
    // Header: logo + contact line
    // -------------------------------------------------------------------------
    const LOGO_W = 50;
    const LOGO_H = 40;
    try {
      const logoPath = resolve(__dirname, "../public/poolsmiths-logo.png");
      const logoData = readFileSync(logoPath).toString("base64");
      const logoX = (PAGE_WIDTH - LOGO_W) / 2;
      doc.addImage(logoData, "PNG", logoX, y, LOGO_W, LOGO_H);
      y += LOGO_H + 3;
    } catch {
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text(COMPANY_NAME, PAGE_WIDTH / 2, y, { align: "center" });
      y += 7;
    }

    // Title — matches the printed paper form's "Pool/Spa Inspection" heading
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("Pool/Spa Inspection", PAGE_WIDTH / 2, y, { align: "center" });
    y += 7;

    // Contact / license block — stacked and centered below the title so it
    // reads as a separate section instead of being jammed under the logo.
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text(COMPANY_PHONE, PAGE_WIDTH / 2, y, { align: "center" });
    y += 4;
    doc.text(COMPANY_EMAIL, PAGE_WIDTH / 2, y, { align: "center" });
    y += 4;
    doc.text(COMPANY_LICENSE, PAGE_WIDTH / 2, y, { align: "center" });
    y += 5;

    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
    y += 5;

    // -------------------------------------------------------------------------
    // Liability disclaimer
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // Job title + submitter
    // -------------------------------------------------------------------------
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
        parts.push(`Date: ${new Date(job.submittedAt).toLocaleDateString()}`);
      doc.text(parts.join("  |  "), MARGIN, y);
      y += 8;
    }

    // -------------------------------------------------------------------------
    // Form fields
    // -------------------------------------------------------------------------
    doc.setFontSize(10);
    let currentSection = "";
    const inlinePhotoUrls = new Set<string>();

    // Build fallback queue for photo fields whose formData value isn't a blob URL
    const formDataPhotoUrls = new Set<string>(
      fields
        .filter((f) => f.type === "photo")
        .map((f) => formData?.[f.id])
        .filter(
          (v): v is string => typeof v === "string" && v.startsWith("http"),
        ),
    );
    const allJobPhotosArr = (job.photos as PhotoMetadata[] | null) ?? [];
    const photosQueue: string[] = allJobPhotosArr
      .map((p) => p.url)
      .filter((u) => !formDataPhotoUrls.has(u));

    for (const field of fields) {
      // Section header (only renders when sections exist in DB)
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

      const rawValue = formData?.[field.id];

      // --- Photo fields: embed inline ---
      if (field.type === "photo") {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        const photoLabelLines = doc.splitTextToSize(field.label, CONTENT_WIDTH);

        // Q108 "Additional Photos" — drain ALL remaining queue photos here
        if (field.id === "108_additional_photos") {
          const directUrl =
            typeof rawValue === "string" && rawValue.startsWith("http")
              ? rawValue
              : null;
          const allExtra: string[] = directUrl ? [directUrl] : [];
          allExtra.push(...photosQueue.splice(0));

          if (y + photoLabelLines.length * 4 + 4 > 280) {
            doc.addPage();
            y = MARGIN;
          }
          doc.text(photoLabelLines, MARGIN, y);
          y += photoLabelLines.length * 4 + 4;

          if (allExtra.length === 0) {
            doc.setFont("helvetica", "normal");
            doc.text("—", MARGIN, y);
            y += 5;
          } else {
            for (const url of allExtra) {
              try {
                const res = await fetch(url);
                const buf = await res.arrayBuffer();
                const b64 = Buffer.from(buf).toString("base64");
                const imgProps = doc.getImageProperties(b64);
                const { imgW, imgH } = fitPhoto(imgProps);
                const imgX = MARGIN + (CONTENT_WIDTH - imgW) / 2;
                if (y + imgH + 8 > 280) {
                  doc.addPage();
                  y = MARGIN;
                }
                doc.addImage(
                  b64,
                  "JPEG",
                  imgX,
                  y,
                  imgW,
                  imgH,
                  undefined,
                  "FAST",
                );
                inlinePhotoUrls.add(url);
                y += imgH + 6;
              } catch {
                // skip failed photo
              }
            }
          }
          continue;
        }

        // All other photo fields — consume one from queue as fallback
        const directUrl =
          typeof rawValue === "string" && rawValue.startsWith("http")
            ? rawValue
            : null;
        const photoUrl = directUrl ?? photosQueue.shift() ?? null;

        if (photoUrl) {
          try {
            const res = await fetch(photoUrl);
            const buf = await res.arrayBuffer();
            const b64 = Buffer.from(buf).toString("base64");
            const imgProps = doc.getImageProperties(b64);
            const { imgW, imgH } = fitPhoto(imgProps);
            const imgX = MARGIN + (CONTENT_WIDTH - imgW) / 2;

            const blockH = photoLabelLines.length * 4 + 3 + imgH + 8;
            if (y + blockH > 280) {
              doc.addPage();
              y = MARGIN;
            }
            doc.text(photoLabelLines, MARGIN, y);
            y += photoLabelLines.length * 4 + 3;
            doc.addImage(b64, "JPEG", imgX, y, imgW, imgH, undefined, "FAST");
            y += imgH + 8;
            inlinePhotoUrls.add(photoUrl);
            continue;
          } catch {
            // fall through to text fallback
          }
        }

        // No URL or fetch failed
        const fallbackLines = doc.splitTextToSize(
          rawValue ? "(photo attached)" : "—",
          CONTENT_WIDTH - 85,
        );
        const photoBlockH =
          Math.max(photoLabelLines.length, fallbackLines.length) * 4 + 2;
        if (y + photoBlockH > 280) {
          doc.addPage();
          y = MARGIN;
        }
        doc.text(photoLabelLines, MARGIN, y);
        doc.setFont("helvetica", "normal");
        doc.text(fallbackLines, MARGIN + 85, y);
        y += photoBlockH;
        continue;
      }

      // --- Non-photo fields ---
      let displayValue: string;
      if (field.type === "checkbox") {
        displayValue = rawValue ? "Yes" : "No";
      } else if (typeof rawValue === "string" && rawValue.trim()) {
        displayValue = rawValue;
      } else {
        displayValue = "—";
      }

      const label = field.label; // preserve question numbering
      const labelWidth = 80;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);

      const labelLines = doc.splitTextToSize(label, labelWidth);
      doc.setFont("helvetica", "normal");
      const valueLines = doc.splitTextToSize(
        displayValue,
        CONTENT_WIDTH - labelWidth - 5,
      );
      const blockHeight =
        Math.max(labelLines.length, valueLines.length) * 4 + 2;

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

    // -------------------------------------------------------------------------
    // Worker signature
    // -------------------------------------------------------------------------
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
        doc.addImage(job.workerSignature as string, "PNG", MARGIN, y, 60, 25);
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
        doc.text(new Date(job.submittedAt).toLocaleDateString(), MARGIN, y);
      }
    }

    // -------------------------------------------------------------------------
    // Save to disk
    // -------------------------------------------------------------------------
    const pdfBytes = doc.output("arraybuffer");
    writeFileSync(OUTPUT_PATH, Buffer.from(pdfBytes));
    console.log(`\nPDF saved to: ${OUTPUT_PATH}`);
    console.log(
      `  Pages: ${doc.getNumberOfPages()}  |  Inline photos: ${inlinePhotoUrls.size}`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
