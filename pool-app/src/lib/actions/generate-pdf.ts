"use server";

import { db } from "@/lib/db";
import { jsPDF } from "jspdf";
import {
  DEFAULT_TEMPLATE,
  type FormData,
  type FormField,
  type FormTemplate,
} from "@/lib/forms";
import { type PhotoMetadata } from "@/lib/photos";
import { readFileSync } from "fs";
import { join } from "path";

const COMPANY_NAME = "Poolsmith's Renovations LLC";
const COMPANY_PHONE = "407-223-5379";
const COMPANY_EMAIL = "poolsmithsrenovations@gmail.com";
const COMPANY_LICENSE = "License CPC1459862";

const PAGE_WIDTH = 210; // A4 mm
const MARGIN = 15;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Fits an image inside a balanced box so portrait and landscape photos feel
// consistent — landscape never fills the full content width, portrait never
// shrinks below a readable minimum. Aspect ratio always preserved.
function fitPhoto(props: { width: number; height: number }): {
  imgW: number;
  imgH: number;
} {
  const MAX_W = 130; // mm — keeps landscape from dominating the page
  const MAX_H = 95; // mm — allows slightly taller portraits than the old 75
  const MIN_W = 70; // mm — prevents tall portraits from becoming slivers
  const ar = props.height / props.width; // >1 = portrait, <1 = landscape

  // Start at the max width, then scale down if height exceeds MAX_H.
  let imgW = MAX_W;
  let imgH = ar * imgW;
  if (imgH > MAX_H) {
    imgH = MAX_H;
    imgW = imgH / ar;
  }
  // Floor for portrait so it doesn't become a sliver — only when widening
  // won't push height back over MAX_H (very tall portraits stay narrow).
  if (imgW < MIN_W && ar * MIN_W <= MAX_H) {
    imgW = MIN_W;
    imgH = ar * imgW;
  }
  return { imgW, imgH };
}

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
    // Logo not found — render company name + title as text fallback
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
  y += d2Lines.length * 3.5 + 6;

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

  // Resolve each photo-question field to a photo URL via a 3-pass strategy.
  // A single consumption set (`consumedPhotoIdxs`) ensures no photo is
  // rendered twice across passes or under Q108.
  //
  //   Pass 1 — explicit binding: URL match, then filename match. External
  //            URLs not in the pool are still rendered as-is.
  //   Pass 2 — legacy sequential fallback: any non-Q108 photo field still
  //            unresolved claims the next unconsumed photo in template
  //            order. Only fires for UNREVIEWED legacy jobs with no
  //            explicit non-Q108 bindings. Once an admin reviews photo
  //            assignments (setting `__photoAssignmentsReviewed = true`
  //            via the admin assignment tool), this pass is skipped so
  //            intentionally-unassigned fields render "—" instead of
  //            being sequence-guessed.
  //   Pass 3 — leftovers: every unconsumed photo drains under Q108 at
  //            render time via `photosQueue`.
  const allJobPhotosArr = (job.photos as PhotoMetadata[] | null) ?? [];
  const consumedPhotoIdxs = new Set<number>();
  const fieldResolvedUrl = new Map<string, string>();

  // Pass 1 — explicit binding.
  for (const field of template.fields) {
    if (field.type !== "photo") continue;
    const raw = formData?.[field.id];
    if (typeof raw !== "string" || !raw) continue;
    const matchesRaw = raw.startsWith("http")
      ? (p: PhotoMetadata) => p.url === raw
      : (p: PhotoMetadata) => p.filename === raw;
    const idx = allJobPhotosArr.findIndex(
      (p, i) => !consumedPhotoIdxs.has(i) && matchesRaw(p),
    );
    if (idx >= 0) {
      consumedPhotoIdxs.add(idx);
      fieldResolvedUrl.set(field.id, allJobPhotosArr[idx].url);
    } else if (
      raw.startsWith("http") &&
      !allJobPhotosArr.some((p) => p.url === raw)
    ) {
      // External URL never in the pool — still render it verbatim.
      fieldResolvedUrl.set(field.id, raw);
    }
    // Orphan filename / duplicate already consumed → leave unresolved
    // so pass 2 can claim a photo by order instead.
  }

  // Pass 2 gate — only runs for untouched legacy jobs.
  //   `reviewed`:        admin has opened the assignment tool and saved. The
  //                      sentinel pins explicit intent; sequence-guessing
  //                      after review would overwrite "intentionally blank."
  //   `hasAnyExplicit`:  any non-Q108 photo field has a non-empty value in
  //                      formData. Fresh jobs (URLs) and partially-assigned
  //                      jobs hit this; Doug-style gallery-only jobs don't.
  const reviewed = formData?.["__photoAssignmentsReviewed"] === true;
  const hasAnyExplicit = template.fields.some(
    (f) =>
      f.type === "photo" &&
      f.id !== "108_additional_photos" &&
      typeof formData?.[f.id] === "string" &&
      (formData[f.id] as string).length > 0,
  );
  if (!reviewed && !hasAnyExplicit) {
    for (const field of template.fields) {
      if (field.type !== "photo") continue;
      if (field.id === "108_additional_photos") continue;
      if (fieldResolvedUrl.has(field.id)) continue;
      const idx = allJobPhotosArr.findIndex(
        (_, i) => !consumedPhotoIdxs.has(i),
      );
      if (idx < 0) continue; // out of photos — leave unresolved → "—"
      consumedPhotoIdxs.add(idx);
      fieldResolvedUrl.set(field.id, allJobPhotosArr[idx].url);
    }
  }

  // Pass 3 queue — every photo not claimed by a non-Q108 field drains
  // under Q108 "Additional Photos" (or the safety drain if Q108 is absent).
  const photosQueue: string[] = allJobPhotosArr
    .filter((_, i) => !consumedPhotoIdxs.has(i))
    .map((p) => p.url);

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

    // --- Photo fields: embed inline below label ---
    if (field.type === "photo") {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      const photoLabelLines = doc.splitTextToSize(field.label, CONTENT_WIDTH);

      // Q108 "Additional Photos" — drain ALL remaining queue photos here.
      // By the time we reach this field every prior photo field has already
      // consumed its share, so photosQueue holds only the leftover extras.
      if (field.id === "108_additional_photos") {
        const directUrl = fieldResolvedUrl.get(field.id) ?? null;
        const allExtra: string[] = directUrl ? [directUrl] : [];
        allExtra.push(...photosQueue.splice(0));
        const labelH = photoLabelLines.length * 4 + 4;

        if (allExtra.length === 0) {
          if (y + labelH + 5 > 280) {
            doc.addPage();
            y = MARGIN;
          }
          doc.text(photoLabelLines, MARGIN, y);
          y += labelH;
          doc.setFont("helvetica", "normal");
          doc.text("—", MARGIN, y);
          y += 5;
          continue;
        }

        // Defer the label draw so it paginates together with the first
        // image that successfully renders — avoids a stranded "Additional
        // Photos" heading at the bottom of a page with its images on the
        // next page. Failures before the first success are buffered and
        // drawn alongside the label once a success lands, so no failed
        // photo is silently dropped from the PDF.
        let labelDrawn = false;
        let preLabelFailures = 0;
        for (const url of allExtra) {
          try {
            const res = await fetch(url);
            const buf = await res.arrayBuffer();
            const b64 = Buffer.from(buf).toString("base64");
            const imgProps = doc.getImageProperties(b64);
            const { imgW, imgH } = fitPhoto(imgProps);
            const imgX = MARGIN + (CONTENT_WIDTH - imgW) / 2;
            if (!labelDrawn) {
              // Bind the label only to the first thing rendered beneath
              // it (a buffered error line or this image) so the heading
              // can't orphan at the bottom. Remaining failures and the
              // image paginate independently so the combined content
              // can never exceed a single page.
              const firstBelowH = preLabelFailures > 0 ? 5 : imgH + 8;
              if (y + labelH + firstBelowH > 280) {
                doc.addPage();
                y = MARGIN;
              }
              doc.setFont("helvetica", "bold");
              doc.setFontSize(9);
              doc.text(photoLabelLines, MARGIN, y);
              y += labelH;
              if (preLabelFailures > 0) {
                doc.setFont("helvetica", "italic");
                doc.setFontSize(8);
                for (let i = 0; i < preLabelFailures; i++) {
                  // First line is bound to the label above; subsequent
                  // lines paginate on their own like post-label catches.
                  if (i > 0 && y + 5 > 280) {
                    doc.addPage();
                    y = MARGIN;
                  }
                  doc.text("[photo could not be loaded]", MARGIN, y);
                  y += 5;
                }
                preLabelFailures = 0;
              }
              labelDrawn = true;
            }
            if (y + imgH + 8 > 280) {
              doc.addPage();
              y = MARGIN;
            }
            doc.addImage(b64, "JPEG", imgX, y, imgW, imgH, undefined, "FAST");
            y += imgH + 6;
          } catch {
            if (!labelDrawn) {
              // Don't draw the label yet — a later fetch may succeed and
              // carry the label + these failure markers with it. Track
              // the count for the combined draw (or the all-failed
              // fallback if no image ever succeeds).
              preLabelFailures++;
              continue;
            }
            if (y + 5 > 280) {
              doc.addPage();
              y = MARGIN;
            }
            doc.setFont("helvetica", "italic");
            doc.setFontSize(8);
            doc.text("[photo could not be loaded]", MARGIN, y);
            y += 5;
          }
        }
        if (!labelDrawn) {
          // Every extra photo failed to fetch. Still surface the heading so
          // the reader sees the question was present, with a consolidated
          // error line.
          if (y + labelH + 5 > 280) {
            doc.addPage();
            y = MARGIN;
          }
          doc.setFont("helvetica", "bold");
          doc.setFontSize(9);
          doc.text(photoLabelLines, MARGIN, y);
          y += labelH;
          doc.setFont("helvetica", "italic");
          doc.setFontSize(8);
          doc.text(
            preLabelFailures > 1
              ? `[${preLabelFailures} photos could not be loaded]`
              : "[photo could not be loaded]",
            MARGIN,
            y,
          );
          y += 5;
        }
        continue;
      }

      // All other photo fields render only the photo resolved from this
      // field's formData entry (either a URL or a legacy filename). Gallery-
      // only photos stay queued for Q108 so they never appear as if answering
      // a different question.
      const photoUrl = fieldResolvedUrl.get(field.id) ?? null;

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
          continue;
        } catch {
          // fall through to text fallback
        }
      }

      // No URL (empty field or orphan legacy filename) or fetch failed.
      const fallbackLines = doc.splitTextToSize(
        photoUrl ? "[photo could not be loaded]" : "—",
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

  // Safety drain — renders any remaining photos for jobs whose template
  // does not contain field id "108_additional_photos" (e.g. DEFAULT_TEMPLATE).
  for (const url of photosQueue.splice(0)) {
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
      doc.addImage(b64, "JPEG", imgX, y, imgW, imgH, undefined, "FAST");
      y += imgH + 6;
    } catch {
      if (y + 5 > 280) {
        doc.addPage();
        y = MARGIN;
      }
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.text("[photo could not be loaded]", MARGIN, y);
      y += 5;
    }
  }

  // --- Worker Signature ---
  if (job.workerSignature) {
    if (y > 230) {
      doc.addPage();
      y = MARGIN;
    }

    y += 5;
    // Divider stroke removed — bare whitespace preserves the same y-offset
    // to the "Worker Signature" heading without a visible rule.
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
