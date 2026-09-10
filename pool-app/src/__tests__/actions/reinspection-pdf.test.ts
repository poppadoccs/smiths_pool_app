import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
vi.mock("@/lib/db", () => ({ db: { job: { findUnique: vi.fn() } } }));
import { db } from "@/lib/db";
import { generateJobPdf } from "@/lib/actions/generate-pdf";
import { ADDITIONAL_PHOTOS_FIELD_ID } from "@/lib/multi-photo";
import {
  appendReinspectionSummary,
  REINSPECTION_FIELD_ID as Q109,
  RESERVED_REINSPECTION_SUMMARY_KEY as KEY,
  REINSPECTION_LABEL,
} from "@/lib/reinspection";
import type { FormData, FormField } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { RESERVED_SUMMARY_KEY } from "@/lib/summary";

const photo: PhotoMetadata = {
  url: "https://test/reinspection.png",
  filename: "reinspection.png",
  size: 1,
  uploadedAt: "2026-09-10",
};
const baseFields: FormField[] = [
  {
    id: "107_summary",
    label: "107. Summary",
    type: "textarea",
    required: false,
    order: 106,
  },
  {
    id: ADDITIONAL_PHOTOS_FIELD_ID,
    label: "108. Additional Photos",
    type: "photo",
    required: false,
    order: 107,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // Real jsPDF + a valid local PNG; no network or customer data is used.
  const png = readFileSync("public/poolsmiths-logo.png");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    })),
  );
});

async function pdf(
  formData: FormData,
  photos: PhotoMetadata[] = [],
  fields = appendReinspectionSummary(baseFields).fields,
) {
  vi.mocked(db.job.findUnique).mockResolvedValue({
    id: "q109-proof",
    name: "[TEST] Reinspection",
    jobNumber: "Q109-TEST",
    status: "DRAFT",
    submittedBy: null,
    submittedAt: null,
    workerSignature: null,
    formData,
    photos,
    template: { id: "q109-test-template", name: "Pool/Spa Inspection", fields },
  } as never);
  const result = await generateJobPdf("q109-proof");
  expect(result.success).toBe(true);
  const buffer = Buffer.from(result.data!.split(",")[1], "base64");
  return { buffer, text: buffer.toString("latin1") };
}

describe("Q109 in a real generated PDF", () => {
  it("omits an empty optional section and preserves the existing summary", async () => {
    const result = await pdf({
      "107_summary": "Original findings",
      [Q109]: " \n ",
    });
    expect(result.text).toContain("Original findings");
    expect(result.text).not.toContain(REINSPECTION_LABEL);
  });
  it("renders notes and attached photos once, after Q108, and can generate a visual proof", async () => {
    const result = await pdf(
      {
        "107_summary": "Initial inspection findings.",
        [KEY]: [
          { text: "Leak repaired.", photos: [photo.url] },
          { text: "Retested successfully.", photos: [] },
        ],
        [RESERVED_SUMMARY_KEY]: [{ text: "Original summary point.", photos: [] }],
      },
      [photo],
    );
    expect(result.text).toContain(REINSPECTION_LABEL);
    expect(result.text).toContain("Leak repaired.");
    expect(result.text).toContain("Retested successfully.");
    expect(result.text.indexOf(REINSPECTION_LABEL)).toBeGreaterThan(
      result.text.indexOf("108. Additional Photos"),
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === photo.url),
    ).toHaveLength(1);
    if (process.env.Q109_PROOF_DIR) {
      mkdirSync(process.env.Q109_PROOF_DIR, { recursive: true });
      writeFileSync(
        join(process.env.Q109_PROOF_DIR, "q109-proof.pdf"),
        result.buffer,
      );
    }
  });
  it("supports notes-only and photos-only reports", async () => {
    expect((await pdf({ [Q109]: "Passed reinspection." })).text).toContain(
      REINSPECTION_LABEL,
    );
    const photosOnly = await pdf(
      { [KEY]: [{ text: "", photos: [photo.url] }] },
      [photo],
    );
    expect(photosOnly.text).toContain(REINSPECTION_LABEL);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === photo.url),
    ).toHaveLength(1);
  });
  it("honors photo exclusions without leaking the attachment into Q108", async () => {
    const result = await pdf({ [KEY]: [{ text: "", photos: [photo.url] }] }, [
      { ...photo, includedInPdf: false },
    ]);
    expect(result.text).not.toContain(REINSPECTION_LABEL);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === photo.url),
    ).toHaveLength(0);
  });
  it("paginates long notes through the last line without overflowing the page", async () => {
    const notes = Array.from(
      { length: 140 },
      (_, i) => `Reinspection observation ${i + 1}.`,
    ).join("\n");
    const result = await pdf({ [KEY]: [{ text: notes, photos: [] }] });
    expect(
      result.text.match(/\/Type \/Page\b/g)!.length,
    ).toBeGreaterThanOrEqual(3);
    expect(result.text).toContain("Reinspection observation 140.");
    // Initial PDF text origins are measured up from the page bottom in
    // points; subsequent Td operations in a block are relative moves.
    const textPositions = [...result.text.matchAll(/BT[\s\S]*?ET/g)]
      .map(([block]) => block.match(/([\d.-]+) ([\d.-]+) Td/))
      .filter((match) => match !== null);
    expect(textPositions.length).toBeGreaterThan(0);
    expect(textPositions.every((match) => Number(match[2]) >= 40)).toBe(true);
    if (process.env.Q109_PROOF_DIR) {
      writeFileSync(
        join(process.env.Q109_PROOF_DIR, "q109-long-notes.pdf"),
        result.buffer,
      );
    }
  });
  it("keeps a Q109 photo out of the legacy fallback for an unrelated photo question", async () => {
    const fields = [
      {
        id: "5_picture_of_pool_and_spa_if_applicable",
        label: "5. Pool photo",
        type: "photo" as const,
        required: false,
        order: 4,
      },
      ...appendReinspectionSummary(baseFields).fields,
    ];
    const result = await pdf(
      { [KEY]: [{ text: "Reinspection photo", photos: [photo.url] }] },
      [photo],
      fields,
    );
    expect(result.text).toContain(REINSPECTION_LABEL);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === photo.url),
    ).toHaveLength(1);
  });
  it("renders Q107 and Q109 bullet points in their own sections", async () => {
    const result = await pdf({
      [RESERVED_SUMMARY_KEY]: [{ text: "ORIGINAL_FINDING", photos: [] }],
      [KEY]: [
        { text: "REINSPECTION_FINDING", photos: [] },
        { text: "SECOND_REINSPECTION_POINT", photos: [] },
      ],
    });
    const start109 = result.text.indexOf(REINSPECTION_LABEL);
    expect(result.text.indexOf("ORIGINAL_FINDING")).toBeLessThan(start109);
    expect(result.text.indexOf("REINSPECTION_FINDING")).toBeGreaterThan(
      start109,
    );
    expect(result.text.indexOf("SECOND_REINSPECTION_POINT")).toBeGreaterThan(
      result.text.indexOf("REINSPECTION_FINDING"),
    );
    expect(result.text.match(/ORIGINAL_FINDING/g)).toHaveLength(1);
  });
});
