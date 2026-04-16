import type { FormTemplate, FormData } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";

type SubmissionEmailProps = {
  jobTitle: string;
  jobNumber: string | null;
  submittedBy: string;
  formData: FormData;
  template: FormTemplate;
  photos: PhotoMetadata[];
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
}: SubmissionEmailProps): string {
  const formRows = template.fields
    .map((field) => {
      const value = formData[field.id];
      let displayValue: string;

      if (field.type === "checkbox") {
        displayValue = value ? "Yes" : "No";
      } else if (field.type === "photo") {
        // formData stores the filename (e.g. "IMG_1234.jpg"), not a blob URL.
        // Real photos are shown as thumbnails in the Photos section below.
        displayValue =
          typeof value === "string" && value.trim() !== ""
            ? "Photo attached"
            : '<span style="color: #999;">—</span>';
      } else if (typeof value === "string" && value.trim() !== "") {
        displayValue = escapeHtml(value);
      } else {
        displayValue = '<span style="color: #999;">—</span>';
      }

      return `
        <tr>
          <td width="40%" style="padding: 8px 12px; border-bottom: 1px solid #e5e5e5; font-weight: 500; width: 40%; vertical-align: top; word-break: break-word; word-wrap: break-word; overflow-wrap: break-word;">
            ${escapeHtml(field.label)}
          </td>
          <td width="60%" style="padding: 8px 12px; border-bottom: 1px solid #e5e5e5; word-break: break-word; word-wrap: break-word; overflow-wrap: break-word;">
            ${displayValue}
          </td>
        </tr>`;
    })
    .join("");

  const photoSection =
    photos.length > 0
      ? `
        <h2 style="font-size: 18px; margin: 24px 0 12px 0; color: #333;">
          Photos (${photos.length})
        </h2>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          ${photos
            .map(
              (photo) => `
            <a href="${escapeHtml(photo.url)}" target="_blank" style="display: inline-block;">
              <img
                src="${escapeHtml(photo.url)}"
                alt="${escapeHtml(photo.filename)}"
                style="width: 150px; height: 150px; object-fit: cover; border-radius: 8px; border: 1px solid #e5e5e5;"
              />
            </a>`,
            )
            .join("")}
        </div>
        <p style="font-size: 13px; color: #888; margin-top: 8px;">
          Click any photo to view full size.
        </p>`
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

    <h2 style="font-size: 18px; margin: 0 0 12px 0; color: #333;">
      Form Details
    </h2>
    <table style="width: 100%; border-collapse: collapse; font-size: 15px; table-layout: fixed;">
      ${formRows}
    </table>

    ${photoSection}

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
