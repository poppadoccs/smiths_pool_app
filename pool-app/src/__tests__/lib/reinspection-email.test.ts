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

function email(
  formData: FormData,
  photos: PhotoMetadata[] = [],
  reportTemplate = template,
) {
  return buildSubmissionEmail({
    jobTitle: "[TEST] Reinspection",
    jobNumber: null,
    submittedBy: "Test",
    template: reportTemplate,
    formData,
    photos,
  });
}

const summaryCases = [
  { id: "107_summary", label: "107. Summary", key: RESERVED_SUMMARY_KEY },
  { id: Q109, label: REINSPECTION_LABEL, key: KEY },
];

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
  it.each(summaryCases)(
    "retains a photo-only legacy reference absent from metadata in $label",
    ({ id, label, key }) => {
      const html = email({ [key]: [{ text: "", photos: [photo.url] }] }, [], {
        ...template,
        fields: [{ ...template.fields[0], id, label }],
      });
      expect(html).toContain(label);
      const document = new DOMParser().parseFromString(html, "text/html");
      expect(
        [...document.querySelectorAll("img")].map((img) => img.src),
      ).toEqual([photo.url]);
    },
  );
  it.each(summaryCases)(
    "honors explicit exclusions and avoids gallery duplicates in $label",
    ({ id, label, key }) => {
      const legacyUrl = "https://test/legacy-summary.jpg";
      const excluded = {
        ...photo,
        url: "https://test/excluded.jpg",
        includedInPdf: false,
      };
      const unrelated = { ...photo, url: "https://test/unrelated.jpg" };
      const html = email(
        {
          [key]: [{ text: "", photos: [legacyUrl, photo.url, excluded.url] }],
        },
        [photo, excluded, unrelated],
        {
          ...template,
          fields: [{ ...template.fields[0], id, label }],
        },
      );
      const document = new DOMParser().parseFromString(html, "text/html");
      const row = [...document.querySelectorAll("tr")].find(
        (candidate) =>
          candidate.firstElementChild?.textContent?.trim() === label,
      );
      expect([...row!.querySelectorAll("img")].map((img) => img.src)).toEqual([
        legacyUrl,
        photo.url,
      ]);
      const allUrls = [...document.querySelectorAll("img")].map(
        (img) => img.src,
      );
      expect(allUrls).toEqual([
        legacyUrl,
        photo.url,
        unrelated.url,
        excluded.url,
      ]);
      expect(html.indexOf(`src="${excluded.url}"`)).toBeGreaterThan(
        html.indexOf("Excluded from PDF"),
      );
    },
  );
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
