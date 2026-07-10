"use server";

import { db } from "@/lib/db";
import { jsPDF } from "jspdf";
import {
  DEFAULT_TEMPLATE,
  isSecondaryField,
  resolveOtherText,
  secondaryFieldFor,
  splitPairedLabel,
  type FormData,
  type FormField,
  type FormTemplate,
} from "@/lib/forms";
import { type PhotoMetadata } from "@/lib/photos";
import {
  ADDITIONAL_PHOTOS_FIELD_ID,
  readFieldPhotoUrls,
  remarksPhotoOwnerIdFor,
  REMARKS_FIELD_IDS,
} from "@/lib/multi-photo";
import {
  collectSummaryPhotoUrls,
  parseSummaryItems,
  SUMMARY_FIELD_ID,
} from "@/lib/summary";
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

  // Centered like the title/contact block above them (client request:
  // "can the text under the logo on the first page be centered").
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "bold");
  const d1Lines = doc.splitTextToSize(disclaimer1, CONTENT_WIDTH);
  doc.text(d1Lines, PAGE_WIDTH / 2, y, { align: "center" });
  y += d1Lines.length * 3.5;

  doc.setFont("helvetica", "normal");
  const d2Lines = doc.splitTextToSize(disclaimer2, CONTENT_WIDTH);
  doc.text(d2Lines, PAGE_WIDTH / 2, y, { align: "center" });
  y += d2Lines.length * 3.5 + 6;

  // NOTE: the bold job-title block that used to render here was removed on
  // client request — job.name is almost always the customer's name, which
  // "1. Inspection performed for" repeats immediately below. The job name
  // still reaches the office via the email subject and the PDF filename.

  // --- Form fields ---
  doc.setFontSize(10);
  let currentSection = "";

  // Resolve each photo-question field to its owned photo URLs via a 3-pass
  // strategy. A single consumption set (`consumedPhotoIdxs`) ensures no
  // photo is rendered twice across passes or under Q108.
  //
  //   Pass 1 — explicit binding: read every URL a field owns via
  //            `readFieldPhotoUrls` (map-first, legacy-mirror fallback),
  //            match each to the pool by URL or legacy filename. External
  //            URLs not in the pool are rendered verbatim. Multi-photo
  //            fields (Q5/Q16/Q25/Q40/Q71) consume ALL their owned URLs
  //            here so slots 1+ never fall through to the Q108 drain.
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
  const fieldResolvedUrls = new Map<string, string[]>();

  // PhotoMetadata.includedInPdf contract (added by CC-B2):
  //   undefined → include (legacy default)
  //   true      → include
  //   false     → exclude from EVERY PDF render touchpoint
  // The exclusion is render-only; ownership/storage are unchanged. The
  // gate lives here (not at field-assignment time) because admins can
  // toggle includedInPdf on an already-assigned photo and the PDF must
  // honor the latest flag without re-saving assignments.
  const isExcludedFromPdf = (p: PhotoMetadata): boolean =>
    p.includedInPdf === false;
  const excludedUrlSet = new Set(
    allJobPhotosArr.filter(isExcludedFromPdf).map((p) => p.url),
  );

  // Pass 1 — explicit binding via the authoritative map-first read path.
  for (const field of template.fields) {
    if (field.type !== "photo") continue;
    const owned = readFieldPhotoUrls(formData, field.id);
    if (owned.length === 0) continue;
    const resolved: string[] = [];
    for (const raw of owned) {
      const matchesRaw = raw.startsWith("http")
        ? (p: PhotoMetadata) => p.url === raw
        : (p: PhotoMetadata) => p.filename === raw;
      const idx = allJobPhotosArr.findIndex(
        (p, i) => !consumedPhotoIdxs.has(i) && matchesRaw(p),
      );
      if (idx >= 0) {
        // Always mark consumed so the photo cannot drain elsewhere
        // (Q108, safety drain, recovery) — the exclusion is a *render*
        // gate, not a re-routing. Push to the resolved list ONLY when
        // not excluded so the field's owned slot stays empty (or shows
        // "—" if it is the field's only owned photo).
        consumedPhotoIdxs.add(idx);
        if (!isExcludedFromPdf(allJobPhotosArr[idx])) {
          resolved.push(allJobPhotosArr[idx].url);
        }
      } else if (
        raw.startsWith("http") &&
        !allJobPhotosArr.some((p) => p.url === raw)
      ) {
        // External URL never in the pool — still render it verbatim.
        // Excluded-from-PDF only applies to URLs in job.photos because
        // the includedInPdf flag lives on PhotoMetadata; an external
        // URL has no PhotoMetadata entry and therefore no flag.
        resolved.push(raw);
      }
      // Orphan filename / duplicate already consumed → leave unresolved
      // so pass 2 can claim a photo by order instead.
    }
    if (resolved.length > 0) {
      fieldResolvedUrls.set(field.id, resolved);
    }
  }

  // Pass 2 gate — only runs for untouched legacy jobs.
  //   `reviewed`:                  admin has opened the assignment tool and
  //                                saved. Sentinel pins explicit intent;
  //                                sequence-guessing after review would
  //                                overwrite "intentionally blank."
  //   `hasAnyResolvableExplicit`:  any non-Q108 photo field whose formData
  //                                value was actually resolved in Pass 1
  //                                (URL match, filename match, or external-
  //                                URL pass-through). Orphan filename strings
  //                                that point to nothing do NOT count — they
  //                                must not block the sequential fallback.
  //                                Example: Kimberly's job stored
  //                                "1000004428.heic" under Q5 but the pool
  //                                only contains "20260416_*.heic"; Pass 1
  //                                leaves Q5 unresolved and the gate opens.
  const reviewed = formData?.["__photoAssignmentsReviewed"] === true;
  const hasAnyResolvableExplicit = template.fields.some(
    (f) =>
      f.type === "photo" &&
      f.id !== ADDITIONAL_PHOTOS_FIELD_ID &&
      fieldResolvedUrls.has(f.id),
  );
  if (!reviewed && !hasAnyResolvableExplicit) {
    for (const field of template.fields) {
      if (field.type !== "photo") continue;
      if (field.id === ADDITIONAL_PHOTOS_FIELD_ID) continue;
      if (fieldResolvedUrls.has(field.id)) continue;
      // Skip excluded photos when picking the next sequential candidate.
      // An excluded photo must never be silently assigned to a field by
      // legacy fallback; if it were, it would render. Leaving it
      // unconsumed here is safe because Pass 3 also filters excluded out
      // of the drain queue.
      const idx = allJobPhotosArr.findIndex(
        (p, i) => !consumedPhotoIdxs.has(i) && !isExcludedFromPdf(p),
      );
      if (idx < 0) continue; // out of photos — leave unresolved → "—"
      consumedPhotoIdxs.add(idx);
      fieldResolvedUrls.set(field.id, [allJobPhotosArr[idx].url]);
    }
  }

  // Pass 2.5 — Remarks-photo consumption. For each remarks textarea field
  // in the template, consume any URL currently owned by the corresponding
  // synthetic `*_remarks_notes_photos` map entry so those photos render
  // inline under the remarks section (below) instead of draining under
  // Q108 as leftovers. Remarks photos are map-only and authoritative; no
  // legacy mirror, no textarea-key collision.
  for (const remarksFieldId of REMARKS_FIELD_IDS) {
    const ownerId = remarksPhotoOwnerIdFor(remarksFieldId);
    if (!ownerId) continue;
    const urls = readFieldPhotoUrls(formData, ownerId);
    for (const url of urls) {
      const idx = allJobPhotosArr.findIndex(
        (p, i) => !consumedPhotoIdxs.has(i) && p.url === url,
      );
      if (idx >= 0) consumedPhotoIdxs.add(idx);
    }
  }

  // Pass 2.6 — Summary-item consumption. Photos attached to structured
  // summary bullets (formData["__summary_items"]) render inline under the
  // "107. Summary" block below; consume them here so they never drain
  // under Q108 as leftovers. Like remarks photos, this is consumption
  // only — the render itself happens at the summary field branch and is
  // independently gated by excludedUrlSet.
  const summaryItems = parseSummaryItems(formData);
  if (summaryItems) {
    for (const url of collectSummaryPhotoUrls(summaryItems)) {
      const idx = allJobPhotosArr.findIndex(
        (p, i) => !consumedPhotoIdxs.has(i) && p.url === url,
      );
      if (idx >= 0) consumedPhotoIdxs.add(idx);
    }
  }

  // Pass 3 queue — every photo not claimed by a non-Q108 field drains
  // under Q108 "Additional Photos" (or the safety drain if Q108 is absent).
  // Excluded photos are filtered out so they never reach Q108 or the
  // safety drain. Pass 1 has already marked excluded URLs consumed when
  // they were owned by a template field; this filter additionally drops
  // any excluded URL that was not claimed by Pass 1 (e.g. orphan/UNASSIGNED
  // excluded photos) so it cannot appear under Q108.
  const photosQueue: string[] = allJobPhotosArr
    .filter((p, i) => !consumedPhotoIdxs.has(i) && !isExcludedFromPdf(p))
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
      const labelH = photoLabelLines.length * 4 + 4;
      const isQ108 = field.id === ADDITIONAL_PHOTOS_FIELD_ID;

      // Resolve the URL list for this field:
      //   - Q108 drains any remaining queue photos on top of its own owned
      //     URLs — by the time we reach Q108, every prior photo field has
      //     already consumed its share.
      //   - Every other photo field renders exactly the URLs it owns via
      //     Pass 1's map-first binding, which includes multi-photo slots
      //     1+ for Q5/Q16/Q25/Q40/Q71. Owning the full list here is what
      //     keeps those slots pinned to their own heading instead of
      //     leaking into the Q108 drain.
      const owned = fieldResolvedUrls.get(field.id) ?? [];
      const urlsToRender: string[] = isQ108
        ? [...owned, ...photosQueue.splice(0)]
        : owned;

      if (urlsToRender.length === 0) {
        // Preserve the two pre-existing empty-state layouts:
        //   - Q108: label on one line, "—" on the next (own-block shape).
        //   - Standalone photo field: label at MARGIN, "—" at MARGIN+85
        //     on the same line (question/answer row shape).
        if (isQ108) {
          if (y + labelH + 5 > 280) {
            doc.addPage();
            y = MARGIN;
          }
          doc.text(photoLabelLines, MARGIN, y);
          y += labelH;
          doc.setFont("helvetica", "normal");
          doc.text("—", MARGIN, y);
          y += 5;
        } else {
          const fallbackLines = doc.splitTextToSize("—", CONTENT_WIDTH - 85);
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
        }
        continue;
      }

      // Defer the label draw so it paginates together with the first image
      // that successfully renders — avoids a stranded heading at the bottom
      // of a page with its images on the next page. Failures before the
      // first success are buffered and drawn alongside the label once a
      // success lands, so no failed photo is silently dropped.
      let labelDrawn = false;
      let preLabelFailures = 0;
      for (const url of urlsToRender) {
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
        // Every photo failed to fetch. Still surface the heading so the
        // reader sees the question was present, with a consolidated error
        // line.
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

    // --- Structured summary: bulleted items with inline photos ---
    // Only when __summary_items exists (parseSummaryItems non-null);
    // legacy jobs whose 107_summary holds a plain string fall through to
    // the generic label/value row below, unchanged.
    if (field.id === SUMMARY_FIELD_ID && summaryItems !== null) {
      // Heading — full-width bold label, like a section
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      const headingLines = doc.splitTextToSize(field.label, CONTENT_WIDTH);
      const headingH = headingLines.length * 4 + 2;
      if (y + headingH + 5 > 280) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(headingLines, MARGIN, y);
      y += headingH;

      if (summaryItems.length === 0) {
        doc.setFont("helvetica", "normal");
        doc.text("—", MARGIN + 4, y);
        y += 5;
        continue;
      }

      for (const item of summaryItems) {
        // Bullet text — never separate the bullet from its first line.
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        const text = item.text.trim() || "(no notes)";
        const itemLines = doc.splitTextToSize(text, CONTENT_WIDTH - 8);
        const itemH = itemLines.length * 4 + 2;
        if (y + itemH > 280) {
          doc.addPage();
          y = MARGIN;
        }
        doc.text("•", MARGIN + 2, y);
        doc.text(itemLines, MARGIN + 7, y);
        y += itemH;

        // Photos under the bullet — same fetch/fit/center pipeline as
        // every other photo, honoring per-photo PDF exclusion.
        const itemUrls = item.photos.filter((u) => !excludedUrlSet.has(u));
        for (const url of itemUrls) {
          try {
            const res = await fetch(url);
            const buf = await res.arrayBuffer();
            const b64 = Buffer.from(buf).toString("base64");
            const imgProps = doc.getImageProperties(b64);
            const { imgW, imgH } = fitPhoto(imgProps);
            const imgX = MARGIN + (CONTENT_WIDTH - imgW) / 2;
            if (y + imgH + 6 > 280) {
              doc.addPage();
              y = MARGIN;
            }
            doc.addImage(b64, "JPEG", imgX, y, imgW, imgH, undefined, "FAST");
            y += imgH + 4;
          } catch {
            if (y + 5 > 280) {
              doc.addPage();
              y = MARGIN;
            }
            doc.setFont("helvetica", "italic");
            doc.setFontSize(8);
            doc.text("[photo could not be loaded]", MARGIN + 7, y);
            y += 5;
            doc.setFontSize(9);
          }
        }
        y += 1;
      }
      y += 2;
      continue;
    }

    // --- Non-photo fields ---
    // Paired fields (X + X_secondary, e.g. Pump Mfg Main/Secondary) render
    // as ONE question row: shared numbered title, one value line per
    // column. The secondary is skipped here and folded into its base row.
    if (isSecondaryField(field, template.fields)) continue;
    const pairedSecondary = secondaryFieldFor(field, template.fields);

    let displayValue: string;
    let label = field.label; // preserve question numbering
    if (pairedSecondary) {
      const columnLine = (f: FormField) => {
        const v = formData?.[f.id];
        let d = typeof v === "string" && v.trim() ? v : "—";
        const otherText = resolveOtherText(f, formData);
        if (otherText) d = `${d} — ${otherText}`;
        return `${splitPairedLabel(f.label).column || f.label}: ${d}`;
      };
      label = splitPairedLabel(field.label).title;
      // splitTextToSize honors \n as hard line breaks.
      displayValue = `${columnLine(field)}\n${columnLine(pairedSecondary)}`;
    } else if (field.type === "checkbox") {
      displayValue = rawValue ? "Yes" : "No";
    } else if (typeof rawValue === "string" && rawValue.trim()) {
      displayValue = rawValue;
      // Companion free-text (e.g. "Other — Aqua-Flo"): appended when the
      // selected option is an allowTextFor trigger and details were typed.
      const otherText = resolveOtherText(field, formData);
      if (otherText) {
        displayValue = `${rawValue} — ${otherText}`;
      }
    } else {
      displayValue = "—";
    }

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

    // Remarks-photo attachments: for a remarks textarea field, render the
    // photos owned via the synthetic `*_remarks_notes_photos` map entry
    // inline below the note text. Map is authoritative; no legacy mirror
    // for remarks photos; textarea note text was already rendered above
    // and is completely separate from the photos bucket.
    const remarksPhotoOwnerId = remarksPhotoOwnerIdFor(field.id);
    if (remarksPhotoOwnerId) {
      const remarksPhotoUrls = readFieldPhotoUrls(
        formData,
        remarksPhotoOwnerId,
      ).filter((u) => !excludedUrlSet.has(u));
      for (const url of remarksPhotoUrls) {
        try {
          const res = await fetch(url);
          const buf = await res.arrayBuffer();
          const b64 = Buffer.from(buf).toString("base64");
          const imgProps = doc.getImageProperties(b64);
          const { imgW, imgH } = fitPhoto(imgProps);
          const imgX = MARGIN + (CONTENT_WIDTH - imgW) / 2;
          if (y + imgH + 6 > 280) {
            doc.addPage();
            y = MARGIN;
          }
          doc.addImage(b64, "JPEG", imgX, y, imgW, imgH, undefined, "FAST");
          y += imgH + 4;
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
    }
  }

  // Recovery — remarks-photo owners whose corresponding textarea field is
  // not in the current template. Pass 2.5 already consumed their URLs so
  // nothing duplicates into the Q108 drain, but the inline render at the
  // textarea branch never fired because the textarea isn't in the
  // template iteration. Without this loop those photos would be silently
  // dropped from the PDF (e.g. trimmed custom templates, or a job that
  // falls back to DEFAULT_TEMPLATE with pre-existing remarks owners).
  // Iteration follows REMARKS_FIELD_IDS declaration order so sections
  // print 15 → 33 → 72 → ... like the paper form.
  const templateFieldIdSet = new Set(template.fields.map((f) => f.id));
  for (const remarksFieldId of REMARKS_FIELD_IDS) {
    if (templateFieldIdSet.has(remarksFieldId)) continue;
    const ownerId = remarksPhotoOwnerIdFor(remarksFieldId);
    if (!ownerId) continue;
    // Filter excluded URLs out of the recovery payload so admins who
    // exclude a remarks photo on a missing-template job still get the
    // exclusion honored. Empty post-filter buckets skip the heading.
    const urls = readFieldPhotoUrls(formData, ownerId).filter(
      (u) => !excludedUrlSet.has(u),
    );
    if (urls.length === 0) continue;

    // Synthesized heading derived from the textarea id's leading number.
    const sectionNum = remarksFieldId.split("_")[0];
    const heading = `Remarks — Section ${sectionNum}`;
    if (y + 8 > 280) {
      doc.addPage();
      y = MARGIN;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(heading, MARGIN, y);
    y += 6;

    for (const url of urls) {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const b64 = Buffer.from(buf).toString("base64");
        const imgProps = doc.getImageProperties(b64);
        const { imgW, imgH } = fitPhoto(imgProps);
        const imgX = MARGIN + (CONTENT_WIDTH - imgW) / 2;
        if (y + imgH + 6 > 280) {
          doc.addPage();
          y = MARGIN;
        }
        doc.addImage(b64, "JPEG", imgX, y, imgW, imgH, undefined, "FAST");
        y += imgH + 4;
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
    doc.text("Inspected by", MARGIN, y);
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
      doc.text(`Submitted by: ${job.submittedBy}`, MARGIN, y);
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
