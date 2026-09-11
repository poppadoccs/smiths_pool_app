import { describe, it, expect } from "vitest";
import { buildSubmissionEmail } from "@/lib/email";
import { RESERVED_SUMMARY_KEY } from "@/lib/summary";
import {
  REINSPECTION_FIELD_ID as Q109,
  RESERVED_REINSPECTION_SUMMARY_KEY as KEY,
  REINSPECTION_LABEL,
} from "@/lib/reinspection";
import type { FormData, FormTemplate } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";

const template: FormTemplate = {
  id: "test-template",
  name: "Pool/Spa Inspection",
  version: 1,
  fields: [
    {
      id: Q109,
      label: REINSPECTION_LABEL,
      type: "textarea",
      required: false,
      order: 108,
    },
  ],
};
const photo: PhotoMetadata = {
  url: "https://test/reinspection.jpg",
  filename: "reinspection.jpg",
  size: 1,
  uploadedAt: "2026-09-10",
};

function email(formData: FormData, photos: PhotoMetadata[] = []) {
  return buildSubmissionEmail({
    jobTitle: "[TEST] Reinspection",
    jobNumber: null,
    submittedBy: "Test",
    template,
    formData,
    photos,
  });
}

describe("Q109 in office email", () => {
  it("omits an unused optional section", () => {
    expect(email({ [Q109]: " \n " }, [photo])).not.toContain(
      REINSPECTION_LABEL,
    );
    expect(
      email({ [KEY]: [{ text: " ", photos: [] }] }, [photo]),
    ).not.toContain(REINSPECTION_LABEL);
  });
  it("includes escaped multiline notes and each assigned photo exactly once", () => {
    const html = email(
      {
        [KEY]: [
          {
            text: "Passed <script>\nNo leaks & stable pressure.",
            photos: [photo.url],
          },
        ],
      },
      [photo],
    );
    expect(html).toContain(REINSPECTION_LABEL);
    expect(html).toContain(
      "Passed &lt;script&gt;<br />No leaks &amp; stable pressure.",
    );
    expect(html.match(/alt="Summary photo"/g)).toHaveLength(1);
    expect(html.match(/src="https:\/\/test\/reinspection.jpg"/g)).toHaveLength(
      1,
    );
  });
  it("allows photos without notes", () => {
    expect(
      email({ [KEY]: [{ text: "", photos: [photo.url] }] }, [photo]),
    ).toContain(REINSPECTION_LABEL);
  });
  it("keeps excluded photos only in the existing reference section", () => {
    const html = email({ [KEY]: [{ text: "", photos: [photo.url] }] }, [
      { ...photo, includedInPdf: false },
    ]);
    expect(html).not.toContain(REINSPECTION_LABEL);
    expect(html).toContain("Excluded from PDF");
    expect(html.match(/src="https:\/\/test\/reinspection.jpg"/g)).toHaveLength(
      1,
    );
  });
  it("uses exactly the same HTML for Q107 and Q109, apart from the heading", () => {
    const items = [
      { text: "First point", photos: [photo.url] },
      { text: "Second point", photos: [] },
    ];
    const original = buildSubmissionEmail({
      jobTitle: "[TEST] Reinspection",
      jobNumber: null,
      submittedBy: "Test",
      template: {
        ...template,
        fields: [
          { ...template.fields[0], id: "107_summary", label: "107. Summary" },
        ],
      },
      formData: { [RESERVED_SUMMARY_KEY]: items },
      photos: [photo],
    });
    expect(
      email({ [KEY]: items }, [photo]).replace(
        REINSPECTION_LABEL,
        "107. Summary",
      ),
    ).toBe(original);
  });
});
