import { beforeEach, describe, expect, it, vi } from "vitest";
const { findUnique, executeRaw } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  executeRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { job: { findUnique }, $executeRaw: executeRaw },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { saveFormData } from "@/lib/actions/forms";
import { saveSummaryItems } from "@/lib/actions/summary";
import {
  REINSPECTION_FIELD_ID as Q109,
  RESERVED_REINSPECTION_SUMMARY_KEY as KEY,
  SUMMARY_FIELD_ID as Q107,
  RESERVED_SUMMARY_KEY,
  SUMMARY_TEXT_MAX_LENGTH,
} from "@/lib/summary";

function makeJob() {
  return {
    id: "q109-test",
    status: "DRAFT",
    formData: {} as Record<string, unknown>,
    photos: Array.from({ length: 32 }, (_, i) => ({
      url: `https://test/${i}.jpg`,
      filename: `${i}.jpg`,
      size: 1,
      uploadedAt: "2026-09-10",
    })),
    template: { fields: [{ id: Q109, type: "textarea" }] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
});

describe("independent Q107/Q109 summary persistence", () => {
  it("saves both summaries alongside form autosave, then clears Q109 without changing Q107", async () => {
    const job = makeJob();
    findUnique.mockImplementation(async () => structuredClone(job));
    executeRaw.mockImplementation(
      async (sql: TemplateStringsArray, value: string) => {
        if (sql.join("").includes("||"))
          job.formData = { ...job.formData, ...JSON.parse(value) };
        else delete job.formData[value];
        return 1;
      },
    );
    const original = [
      { text: "Original findings", photos: [job.photos[0].url] },
    ];
    const reinspect = [
      { text: "Leak repaired", photos: [job.photos[1].url] },
      { text: "Retested", photos: [] },
    ];
    await Promise.all([
      saveSummaryItems(job.id, original),
      saveSummaryItems(job.id, reinspect, Q109),
      saveFormData(job.id, {
        customer: "Test",
        [KEY]: [],
        [RESERVED_SUMMARY_KEY]: [],
      }),
    ]);
    expect(job.formData).toMatchObject({
      customer: "Test",
      [RESERVED_SUMMARY_KEY]: original,
      [KEY]: reinspect,
    });
    await saveSummaryItems(job.id, [...reinspect].reverse(), Q109);
    expect(job.formData[KEY]).toEqual([...reinspect].reverse());
    expect(job.formData[RESERVED_SUMMARY_KEY]).toEqual(original);
    await saveSummaryItems(job.id, [], Q109);
    expect(job.formData).not.toHaveProperty(KEY);
    expect(job.formData[RESERVED_SUMMARY_KEY]).toEqual(original);
    expect(job.formData.customer).toBe("Test");
  });

  it("refuses a missing Q109 template and an arbitrary reserved-key target", async () => {
    findUnique.mockResolvedValue({ ...makeJob(), template: { fields: [] } });
    expect((await saveSummaryItems("q109-test", [], Q109)).success).toBe(false);
    expect(
      (await saveSummaryItems("q109-test", [], "__customer_data" as never))
        .success,
    ).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTED", "ARCHIVED"])(
    "refuses changes to a %s job",
    async (status) => {
      findUnique.mockResolvedValue({ ...makeJob(), status });
      expect((await saveSummaryItems("q109-test", [], Q109)).success).toBe(
        false,
      );
      expect(executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each([Q107, Q109] as const)(
    "enforces the same text, item-photo, total-photo and ownership rules for %s",
    async (fieldId) => {
      const job = makeJob();
      findUnique.mockResolvedValue(job);
      const urls = job.photos.map((p) => p.url);
      expect(
        (
          await saveSummaryItems(
            job.id,
            [{ text: "unknown", photos: ["https://foreign/photo.jpg"] }],
            fieldId,
          )
        ).success,
      ).toBe(false);
      expect(
        (
          await saveSummaryItems(
            job.id,
            [{ text: "nine", photos: urls.slice(0, 9) }],
            fieldId,
          )
        ).success,
      ).toBe(false);
      expect(
        (
          await saveSummaryItems(
            job.id,
            [{ text: "x".repeat(SUMMARY_TEXT_MAX_LENGTH + 1), photos: [] }],
            fieldId,
          )
        ).success,
      ).toBe(false);
      const items = [0, 1, 2, 3].map((i) => ({
        text: `point ${i}`,
        photos: urls.slice(i * 8, i * 8 + 8),
      }));
      expect((await saveSummaryItems(job.id, items, fieldId)).success).toBe(
        false,
      );
      expect(executeRaw).not.toHaveBeenCalled();
      items[3].photos = items[3].photos.slice(0, 6);
      expect(await saveSummaryItems(job.id, items, fieldId)).toEqual({
        success: true,
      });
    },
  );

  it("surfaces a status change during the atomic write", async () => {
    findUnique.mockResolvedValue(makeJob());
    executeRaw.mockResolvedValue(0);
    expect(
      (
        await saveSummaryItems(
          "q109-test",
          [{ text: "Retested", photos: [] }],
          Q109,
        )
      ).error,
    ).toMatch(/no longer editable/);
  });
});
