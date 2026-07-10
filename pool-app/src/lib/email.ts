import {
  isSecondaryField,
  resolveOtherText,
  secondaryFieldFor,
  splitPairedLabel,
  type FormField,
  type FormTemplate,
  type FormData,
} from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { parseSummaryItems, SUMMARY_FIELD_ID } from "@/lib/summary";

type SubmissionEmailProps = {
  jobTitle: string;
  jobNumber: string | null;
  submittedBy: string;
  formData: FormData;
  template: FormTemplate;
  photos: PhotoMetadata[];
  editUrl?: string;
};

/**
 * Builds an HTML email for the wife to review.
 * Simple table layout — works in all email clients.
 */
export function buildSubmissionEmail({
  jobTitle,
  jobNumber,
  submittedBy,
  formData,
  template,
  photos,
  editUrl,
}: SubmissionEmailProps): string {
  const summaryItems = parseSummaryItems(formData);

  const formRows = template.fields
    .map((field) => {
      // Paired fields (X + X_secondary) fold into ONE row on the base
      // field: shared title, one line per column. Mirrors the PDF.
      if (isSecondaryField(field, template.fields)) return "";
      const pairedSecondary = secondaryFieldFor(field, template.fields);

      const value = formData[field.id];
      let rowLabel = field.label;
      let displayValue: string;

      if (pairedSecondary) {
        const columnLine = (f: FormField) => {
          const v = formData[f.id];
          let d =
            typeof v === "string" && v.trim() !== ""
              ? escapeHtml(v)
              : '<span style="color: #999;">—</span>';
          const otherText = resolveOtherText(f, formData);
          if (otherText) d = `${d} — ${escapeHtml(otherText)}`;
          return `<strong>${escapeHtml(
            splitPairedLabel(f.label).column || f.label,
          )}:</strong> ${d}`;
        };
        rowLabel = splitPairedLabel(field.label).title;
        displayValue = `${columnLine(field)}<br />${columnLine(pairedSecondary)}`;
      } else if (field.id === SUMMARY_FIELD_ID && summaryItems !== null) {
        // Structured summary — bulleted items, each with its attached
        // photo thumbnails. Mirrors the PDF's summary block.
        displayValue =
          summaryItems.length === 0
            ? '<span style="color: #999;">—</span>'
            : `<ul style="margin: 0; padding-left: 18px;">${summaryItems
                .map((item) => {
                  const text = item.text.trim()
                    ? escapeHtml(item.text.trim())
                    : '<span style="color: #999;">(no notes)</span>';
                  const thumbs = item.photos
                    .map(
                      (url) => `
                        <a href="${escapeHtml(url)}" target="_blank" style="text-decoration: none;">
                          <img src="${escapeHtml(url)}" alt="Summary photo" width="150" border="0"
                               style="display: inline-block; width: 150px; max-width: 100%; height: auto; border-radius: 4px; border: 1px solid #e5e5e5; margin: 4px 4px 0 0;" />
                        </a>`,
                    )
                    .join("");
                  return `<li style="margin-bottom: 8px;">${text}${
                    thumbs
                      ? `<div style="margin-top: 2px;">${thumbs}</div>`
                      : ""
                  }</li>`;
                })
                .join("")}</ul>`;
      } else if (field.type === "checkbox") {
        displayValue = value ? "Yes" : "No";
      } else if (field.type === "photo") {
        // formData stores the filename (e.g. "IMG_1234.jpg"), not a blob URL.
        // Real photos are shown as thumbnails in the Photos section below.
        displayValue =
          typeof value === "string" && value.trim() !== ""
            ? "Photo attached"
            : '<span style="color: #999;">—</span>';
      } else if (typeof value === "string" && value.trim() !== "") {
        // Companion free-text (e.g. "Other — Aqua-Flo") — same rule as
        // the PDF renderer.
        const otherText = resolveOtherText(field, formData);
        displayValue = escapeHtml(
          otherText ? `${value} — ${otherText}` : value,
        );
      } else {
        displayValue = '<span style="color: #999;">—</span>';
      }

      return `
        <tr>
          <td width="160" style="padding: 8px 10px 8px 0; border-bottom: 1px solid #e5e5e5; font-weight: 600; font-size: 13px; width: 160px; min-width: 140px; vertical-align: top; color: #555; white-space: normal; word-break: break-word; word-wrap: break-word; overflow-wrap: break-word;">
            ${escapeHtml(rowLabel)}
          </td>
          <td style="padding: 8px 0 8px 12px; border-bottom: 1px solid #e5e5e5; font-size: 14px; vertical-align: top; word-break: break-word; word-wrap: break-word; overflow-wrap: break-word;">
            ${displayValue}
          </td>
        </tr>`;
    })
    .join("");

  // Split photos by PDF inclusion. Treat undefined and true identically as
  // "included" — preserves pre-feature behavior for legacy photos. Excluded
  // photos are STILL delivered in the email body as a separate "for
  // reference" section, so the office can see what was uploaded but
  // intentionally kept out of the PDF report.
  const includedPhotos = photos.filter((p) => p.includedInPdf !== false);
  const excludedPhotos = photos.filter((p) => p.includedInPdf === false);

  function renderPhotoTile(photo: PhotoMetadata, i: number): string {
    return `
            <a href="${escapeHtml(photo.url)}" target="_blank" style="display: block; margin-bottom: 10px; text-decoration: none;">
              <img
                src="${escapeHtml(photo.url)}"
                alt="Photo ${i + 1}"
                width="550"
                border="0"
                style="display: block; width: 100%; max-width: 550px; height: auto; box-sizing: border-box; border-radius: 6px; border: 1px solid #e5e5e5;"
              />
            </a>`;
  }

  const photoSection =
    includedPhotos.length > 0
      ? `
        <h2 style="font-size: 18px; margin: 24px 0 12px 0; color: #333;">
          Photos (${includedPhotos.length})
        </h2>
        <div style="width: 100%; max-width: 100%;">
          ${includedPhotos.map(renderPhotoTile).join("")}
        </div>
        <p style="font-size: 13px; color: #888; margin-top: 4px;">
          Click any photo to view full size.
        </p>`
      : "";

  const excludedSection =
    excludedPhotos.length > 0
      ? `
        <h2 style="font-size: 18px; margin: 24px 0 12px 0; color: #333;">
          Excluded from PDF — for reference (${excludedPhotos.length})
        </h2>
        <p style="font-size: 13px; color: #666; margin: 0 0 12px 0;">
          These photos are uploaded to the job but the field worker chose to
          keep them out of the PDF report. They are included here so you have
          the full set if you need them.
        </p>
        <div style="width: 100%; max-width: 100%;">
          ${excludedPhotos.map(renderPhotoTile).join("")}
        </div>`
      : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; background: #fafafa;">
  <div style="background: #fff; border-radius: 12px; padding: 24px; border: 1px solid #e5e5e5;">
    <h1 style="font-size: 22px; margin: 0 0 4px 0; color: #111;">
      ${escapeHtml(jobTitle)}
    </h1>
    ${jobNumber ? `<p style="font-size: 15px; color: #666; margin: 0 0 8px 0;">#${escapeHtml(jobNumber)}</p>` : ""}
    <p style="font-size: 14px; color: #888; margin: 0 0 20px 0;">
      Submitted by <strong>${escapeHtml(submittedBy)}</strong>
    </p>

    ${
      editUrl
        ? `
    <p style="margin: 0 0 8px 0;">
      <a href="${escapeHtml(editUrl)}"
         style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; font-weight: 600; padding: 10px 16px; border-radius: 8px; font-size: 14px;">
        Open editable version
      </a>
    </p>
    <p style="font-size: 12px; color: #888; margin: 0 0 20px 0;">
      Open this job in the pool forms app so it can be edited and re-sent.
    </p>
    `
        : ""
    }

    <h2 style="font-size: 18px; margin: 0 0 12px 0; color: #333;">
      Form Details
    </h2>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      ${formRows}
    </table>

    ${photoSection}

    ${excludedSection}

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
    <p style="font-size: 12px; color: #aaa; margin: 0;">
      Sent from Pool Field Forms
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
