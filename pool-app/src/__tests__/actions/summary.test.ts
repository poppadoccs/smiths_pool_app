// saveSummaryItems — dedicated reserved-key writer for __summary_items.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { saveSummaryItems } from "@/lib/actions/summary";
import {
  SUMMARY_PER_ITEM_CAP,
  SUMMARY_PHOTO_TOTAL_CAP,
  SUMMARY_TEXT_MAX_LENGTH,
} from "@/lib/summary";
import { db } from "@/lib/db";

function draftJob(photoUrls: string[]) {
  return {
    id: "job-1",
    status: "DRAFT",
    photos: photoUrls.map((url) => ({
      url,
      filename: "f.jpg",
      size: 1,
      uploadedAt: "2026-07-01",
    })),
    formData: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.$executeRaw).mockResolvedValue(1 as never);
});

describe("saveSummaryItems", () => {
  it("saves normalized items through an atomic single-key jsonb patch", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      draftJob(["http://p/1", "http://p/2"]) as never,
    );

    const res = await saveSummaryItems("job-1", [
      { text: "Algae on steps", photos: ["http://p/1"] },
      { text: "Inlet loose", photos: ["http://p/2"] },
    ]);
    expect(res).toEqual({ success: true });

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    // The tagged-template values include the serialized patch — assert the
    // reserved key and item text made it into the interpolations.
    const call = vi.mocked(db.$executeRaw).mock.calls[0];
    const serialized = JSON.stringify(call);
    expect(serialized).toContain("__summary_items");
    expect(serialized).toContain("Algae on steps");
  });

  it("dedupes photo URLs within an item (order preserved)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      draftJob(["http://p/1", "http://p/2"]) as never,
    );

    const res = await saveSummaryItems("job-1", [
      {
        text: "t",
        photos: ["http://p/1", "http://p/1", "http://p/2", "http://p/1"],
      },
    ]);
    expect(res).toEqual({ success: true });
    const serialized = JSON.stringify(vi.mocked(db.$executeRaw).mock.calls[0]);
    // Deduped list: p1 then p2, no triple p1.
    expect(serialized).toContain(
      JSON.stringify(["http://p/1", "http://p/2"]).replace(/"/g, '\\"'),
    );
  });

  it("empty items list deletes the reserved key (legacy path takes over)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(draftJob([]) as never);

    const res = await saveSummaryItems("job-1", []);
    expect(res).toEqual({ success: true });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("rejects when a photo URL is not owned by the job", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      draftJob(["http://p/1"]) as never,
    );

    const res = await saveSummaryItems("job-1", [
      { text: "t", photos: ["http://p/unknown"] },
    ]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unknown photo/);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects a non-DRAFT job", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      ...draftJob([]),
      status: "SUBMITTED",
    } as never);

    const res = await saveSummaryItems("job-1", []);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/draft/i);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects when one item exceeds the per-item photo cap", async () => {
    const urls = Array.from(
      { length: SUMMARY_PER_ITEM_CAP + 1 },
      (_, i) => `http://p/${i}`,
    );
    vi.mocked(db.job.findUnique).mockResolvedValue(draftJob(urls) as never);

    const res = await saveSummaryItems("job-1", [{ text: "t", photos: urls }]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Too many photos on one/);
  });

  it("rejects when total photos exceed the summary cap", async () => {
    // 4 items × 8 photos = 32 > 30 total cap (each item is under the
    // per-item cap so only the total check can catch it).
    const urls = Array.from({ length: 32 }, (_, i) => `http://p/${i}`);
    vi.mocked(db.job.findUnique).mockResolvedValue(draftJob(urls) as never);

    const items = [0, 1, 2, 3].map((k) => ({
      text: `item ${k}`,
      photos: urls.slice(k * 8, k * 8 + 8),
    }));
    const totalRequested = items.reduce((n, it) => n + it.photos.length, 0);
    expect(totalRequested).toBeGreaterThan(SUMMARY_PHOTO_TOTAL_CAP);

    const res = await saveSummaryItems("job-1", items);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Too many summary photos/);
  });

  it("rejects malformed items and over-long text", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(draftJob([]) as never);

    expect(
      (await saveSummaryItems("job-1", [{ photos: [] } as never])).success,
    ).toBe(false);
    expect(
      (await saveSummaryItems("job-1", [{ text: "t" } as never])).success,
    ).toBe(false);
    expect(
      (
        await saveSummaryItems("job-1", [
          { text: "x".repeat(SUMMARY_TEXT_MAX_LENGTH + 1), photos: [] },
        ])
      ).success,
    ).toBe(false);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("surfaces the atomic status-guard failure (0 rows affected)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(draftJob([]) as never);
    vi.mocked(db.$executeRaw).mockResolvedValue(0 as never);

    const res = await saveSummaryItems("job-1", [{ text: "t", photos: [] }]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer editable/);
  });
});
