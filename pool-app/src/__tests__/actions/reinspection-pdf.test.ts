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
  url: "https://test-store.public.blob.vercel-storage.com/reinspection.png",
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
      ok: true,
      redirected: false,
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

function textBlocks(pdfText: string): string[] {
  return [...pdfText.matchAll(/BT[\s\S]*?ET/g)].map(([block]) => block);
}

function expectTextWithinPage(blocks: string[]) {
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    const origin = block.match(/([\d.-]+) ([\d.-]+) Td/);
    const leading = block.match(/([\d.-]+) TL/);
    expect(origin).not.toBeNull();
    expect(leading).not.toBeNull();
    // A valid starting point can still hide the last lines below the page.
    // jsPDF uses T* to move down by the block's line spacing (TL).
    const lineMoves = (block.match(/(?:^|\n)T\*/g) ?? []).length;
    const lastBaseline = Number(origin![2]) - lineMoves * Number(leading![1]);
    expect(lastBaseline).toBeGreaterThanOrEqual(40);
  }
}

const summaryCases = [
  { id: "107_summary", label: "107. Summary", key: RESERVED_SUMMARY_KEY },
  { id: Q109, label: REINSPECTION_LABEL, key: KEY },
];

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
        [RESERVED_SUMMARY_KEY]: [
          { text: "Original summary point.", photos: [] },
        ],
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
  it("renders a legacy raster data image without making a network request", async () => {
    const url = `data:image/png;base64,${readFileSync("public/poolsmiths-logo.png").toString("base64")}`;
    const result = await pdf(
      { [KEY]: [{ text: "Local image", photos: [url] }] },
      [{ ...photo, url }],
    );
    expect(result.text).toContain(REINSPECTION_LABEL);
    expect(result.text).not.toContain("[photo could not be loaded]");
    expect(fetch).not.toHaveBeenCalled();
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
  it.each(summaryCases)(
    "renders legacy summary URLs once while honoring exclusions in $label",
    async ({ label, key }) => {
      const legacyUrl =
        "https://test-store.public.blob.vercel-storage.com/legacy-summary.png";
      const excluded = {
        ...photo,
        url: "https://test-store.public.blob.vercel-storage.com/excluded.png",
        includedInPdf: false,
      };
      const result = await pdf(
        {
          [key]: [{ text: "", photos: [legacyUrl, photo.url, excluded.url] }],
        },
        [photo, excluded],
      );
      expect(result.text).toContain(label);
      expect(result.text).not.toContain("[photo could not be loaded]");
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
        legacyUrl,
        photo.url,
      ]);
    },
  );
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
    expectTextWithinPage(
      textBlocks(result.text).filter((block) =>
        block.includes("Reinspection observation"),
      ),
    );
    if (process.env.Q109_PROOF_DIR) {
      writeFileSync(
        join(process.env.Q109_PROOF_DIR, "q109-long-notes.pdf"),
        result.buffer,
      );
    }
  });
  it.each(summaryCases)(
    "paginates every line of a long plain legacy $label",
    async ({ id, label }) => {
      const notes = Array.from(
        { length: 140 },
        (_, i) => `Legacy line ${i + 1}.`,
      ).join("\n");
      const result = await pdf({ [id]: notes });
      const blocks = textBlocks(result.text).filter((block) =>
        block.includes("Legacy line"),
      );
      expect(result.text).toContain(label);
      expect(
        result.text.match(/\/Type \/Page\b/g)!.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        [...result.text.matchAll(/Legacy line (\d+)\./g)].map((match) =>
          Number(match[1]),
        ),
      ).toEqual(Array.from({ length: 140 }, (_, i) => i + 1));
      expectTextWithinPage(blocks);
      for (const block of blocks) {
        const origin = block.match(/([\d.-]+) ([\d.-]+) Td/)!;
        expect(Number(origin[1])).toBeCloseTo((100 * 72) / 25.4, 5);
      }
    },
  );
  it.each(summaryCases)(
    "preserves the ordinary short legacy label/value layout for $label",
    async ({ id, label }) => {
      const notes = "Short legacy summary.\nFollow-up confirmed.";
      const field = { ...baseFields[0], id, label };
      const result = await pdf({ [id]: notes }, [], [field]);
      const control = await pdf(
        { legacy_control: notes },
        [],
        [{ ...field, id: "legacy_control" }],
      );
      expect(textBlocks(result.text)).toEqual(textBlocks(control.text));
    },
  );
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
