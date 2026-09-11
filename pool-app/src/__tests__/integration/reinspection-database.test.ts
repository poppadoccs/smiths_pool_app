// @vitest-environment node
// Opt-in proof against an explicitly selected, isolated Neon branch.
// Database reads and writes use the real Prisma adapter and application actions.
// Cache invalidation and Blob deletion are mocked; no email is sent.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FormData, FormField } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { buildSubmissionEmail } from "@/lib/email";
import {
  REINSPECTION_FIELD_ID,
  RESERVED_REINSPECTION_SUMMARY_KEY,
  RESERVED_SUMMARY_KEY,
} from "@/lib/summary";
import { REINSPECTION_LABEL } from "@/lib/reinspection";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined) }));

const enabled = process.env.Q109_VERIFY_DATABASE === "1";
const jobId = `qa-q109-${randomUUID()}`;
let db: typeof import("@/lib/db")["db"];
let summary: typeof import("@/lib/actions/summary");
let forms: typeof import("@/lib/actions/forms");
let photos: typeof import("@/lib/actions/photos");
let pdf: typeof import("@/lib/actions/generate-pdf");
let baselineDigest: string;
let created = false;

async function otherJobsDigest() {
  const rows = await db.$queryRaw<{ digest: string }[]>`
    SELECT md5(COALESCE(string_agg(md5(row_to_json(j)::text), '' ORDER BY id), '')) AS digest
    FROM jobs j WHERE id <> ${jobId}
  `;
  return rows[0].digest;
}

describe.skipIf(!enabled)("Q109 with the real isolated database", () => {
  beforeAll(async () => {
    const expectedHost = process.env.Q109_VERIFICATION_HOST;
    if (!expectedHost || !process.env.Q109_VERIFICATION_TEMPLATE_ID)
      throw new Error("Explicit isolated host and template ID are required.");
    expect(new URL(process.env.DATABASE_URL!).hostname).toBe(expectedHost);
    expect(process.env.Q109_VERIFICATION_BRANCH_NAME).toMatch(/^q109-verification-/);
    ({ db } = await import("@/lib/db"));
    [summary, forms, photos, pdf] = await Promise.all([
      import("@/lib/actions/summary"),
      import("@/lib/actions/forms"),
      import("@/lib/actions/photos"),
      import("@/lib/actions/generate-pdf"),
    ]);
    baselineDigest = await otherJobsDigest();
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    try {
      if (created) await db.job.delete({ where: { id: jobId } });
      if (baselineDigest) expect(await otherJobsDigest()).toBe(baselineDigest);
    } finally {
      await db.$disconnect();
    }
  }, 30_000);

  it("persists independent summaries, renders reports, and cleans up only the test draft", async () => {
    const template = await db.formTemplate.findUniqueOrThrow({
      where: { id: process.env.Q109_VERIFICATION_TEMPLATE_ID! },
    });
    const fields = template.fields as unknown as FormField[];
    expect(fields.at(-1)).toMatchObject({
      id: REINSPECTION_FIELD_ID,
      label: REINSPECTION_LABEL,
      required: false,
      type: "textarea",
    });
    const baseForm = Object.fromEntries(fields.map((field) => [field.id, ""])) as FormData;
    await db.job.create({
      data: {
        id: jobId,
        name: "[TEST] Q109 database verification",
        jobNumber: "QA-Q109",
        status: "DRAFT",
        templateId: template.id,
        formData: { ...baseForm, __verification_marker: "preserve" },
      },
    });
    created = true;
    const firstPng = readFileSync("public/poolsmiths-logo.png");
    const secondPng = readFileSync("public/icon-192.png");
    const firstPhoto = `data:image/png;base64,${firstPng.toString("base64")}`;
    const secondPhoto = `data:image/png;base64,${secondPng.toString("base64")}`;
    await photos.savePhotoMetadata(jobId, { url: firstPhoto, filename: "qa-original.png", size: firstPng.length });
    await photos.savePhotoMetadata(jobId, { url: secondPhoto, filename: "qa-reinspection.png", size: secondPng.length });

    const original = [{ text: "ORIGINAL_DATABASE_FINDING", photos: [firstPhoto] }];
    const reinspect = [
      { text: "REINSPECTION_DATABASE_FINDING", photos: [secondPhoto] },
      { text: "SECOND_REINSPECTION_POINT", photos: [] },
    ];
    const results = await Promise.all([
      summary.saveSummaryItems(jobId, original),
      summary.saveSummaryItems(jobId, reinspect, REINSPECTION_FIELD_ID),
      forms.saveFormData(jobId, {
        ...baseForm,
        [RESERVED_SUMMARY_KEY]: [],
        [RESERVED_REINSPECTION_SUMMARY_KEY]: [],
      }),
    ]);
    expect(results.slice(0, 2)).toEqual([{ success: true }, { success: true }]);
    let reopened = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(reopened.formData).toMatchObject({
      [RESERVED_SUMMARY_KEY]: original,
      [RESERVED_REINSPECTION_SUMMARY_KEY]: reinspect,
      __verification_marker: "preserve",
    });

    const filledPdf = await pdf.generateJobPdf(jobId);
    expect(filledPdf.success).toBe(true);
    const pdfBuffer = Buffer.from(filledPdf.data!.split(",")[1], "base64");
    const pdfText = pdfBuffer.toString("latin1");
    expect(pdfText).toContain(REINSPECTION_LABEL);
    expect(pdfText).toContain("ORIGINAL_DATABASE_FINDING");
    expect(pdfText).toContain("REINSPECTION_DATABASE_FINDING");
    expect(pdfText).not.toContain("photo could not be loaded");
    expect(pdfText.indexOf("ORIGINAL_DATABASE_FINDING")).toBeLessThan(pdfText.indexOf(REINSPECTION_LABEL));
    expect(pdfText.indexOf("REINSPECTION_DATABASE_FINDING")).toBeGreaterThan(pdfText.indexOf(REINSPECTION_LABEL));

    const makeEmail = (job: typeof reopened) => buildSubmissionEmail({
      jobTitle: job.name!, jobNumber: job.jobNumber, submittedBy: "QA only",
      formData: job.formData as FormData,
      template: { id: template.id, name: template.name, version: 1, fields },
      photos: job.photos as unknown as PhotoMetadata[],
    });
    const emailHtml = makeEmail(reopened);
    expect(emailHtml).toContain(REINSPECTION_LABEL);
    expect(emailHtml).toContain("REINSPECTION_DATABASE_FINDING");
    const proofDir = process.env.Q109_PROOF_DIR;
    if (proofDir) {
      mkdirSync(proofDir, { recursive: true });
      writeFileSync(join(proofDir, "q109-real-database.pdf"), pdfBuffer);
      writeFileSync(join(proofDir, "q109-real-database-email.html"), emailHtml);
    }

    expect(await summary.saveSummaryItems(jobId, [...reinspect].reverse(), REINSPECTION_FIELD_ID)).toEqual({ success: true });
    reopened = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect((reopened.formData as FormData)[RESERVED_REINSPECTION_SUMMARY_KEY]).toEqual([...reinspect].reverse());
    expect((reopened.formData as FormData)[RESERVED_SUMMARY_KEY]).toEqual(original);

    expect((await summary.saveSummaryItems(jobId, [{ text: "foreign", photos: ["https://example.invalid/foreign.jpg"] }], REINSPECTION_FIELD_ID)).success).toBe(false);
    await photos.setPhotoIncludedInPdf(jobId, secondPhoto, false);
    expect(await summary.saveSummaryItems(jobId, [{ text: "", photos: [secondPhoto] }], REINSPECTION_FIELD_ID)).toEqual({ success: true });
    const excludedPdf = await pdf.generateJobPdf(jobId);
    expect(excludedPdf.success).toBe(true);
    expect(Buffer.from(excludedPdf.data!.split(",")[1], "base64").toString("latin1")).not.toContain(REINSPECTION_LABEL);
    await photos.setPhotoIncludedInPdf(jobId, secondPhoto, true);
    const photoOnlyPdf = await pdf.generateJobPdf(jobId);
    expect(photoOnlyPdf.success).toBe(true);
    expect(Buffer.from(photoOnlyPdf.data!.split(",")[1], "base64").toString("latin1")).toContain(REINSPECTION_LABEL);

    expect(await summary.saveSummaryItems(jobId, reinspect, REINSPECTION_FIELD_ID)).toEqual({ success: true });
    await photos.deletePhoto(jobId, secondPhoto);
    reopened = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect((reopened.formData as FormData)[RESERVED_REINSPECTION_SUMMARY_KEY]).toEqual(reinspect.map((item) => ({ ...item, photos: [] })));
    expect((reopened.formData as FormData)[RESERVED_SUMMARY_KEY]).toEqual(original);
    expect((reopened.photos as unknown as PhotoMetadata[]).map((photo) => photo.url)).toEqual([firstPhoto]);

    expect(await summary.saveSummaryItems(jobId, [], REINSPECTION_FIELD_ID)).toEqual({ success: true });
    reopened = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(reopened.formData).not.toHaveProperty(RESERVED_REINSPECTION_SUMMARY_KEY);
    expect((reopened.formData as FormData)[RESERVED_SUMMARY_KEY]).toEqual(original);
    const blankPdf = await pdf.generateJobPdf(jobId);
    expect(blankPdf.success).toBe(true);
    expect(Buffer.from(blankPdf.data!.split(",")[1], "base64").toString("latin1")).not.toContain(REINSPECTION_LABEL);
    expect(makeEmail(reopened)).not.toContain(REINSPECTION_LABEL);

    await db.job.update({ where: { id: jobId }, data: { status: "SUBMITTED" } });
    expect((await summary.saveSummaryItems(jobId, reinspect, REINSPECTION_FIELD_ID)).success).toBe(false);
    expect(await otherJobsDigest()).toBe(baselineDigest);
  }, 90_000);
});
