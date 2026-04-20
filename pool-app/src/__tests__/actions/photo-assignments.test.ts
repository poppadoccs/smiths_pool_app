import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { assignMultiFieldPhotos } from "@/lib/actions/photo-assignments";
import { db } from "@/lib/db";
import {
  MULTI_PHOTO_CAPS,
  RESERVED_PHOTO_MAP_KEY,
  REVIEWED_FLAG,
} from "@/lib/multi-photo";

const Q5 = "5_picture_of_pool_and_spa_if_applicable";
const Q5_CAP = MULTI_PHOTO_CAPS[Q5]!; // 5, locked 2026-04-20
const Q16 = "16_photo_of_pool_pump";

function writtenFormData(): Record<string, unknown> {
  const calls = vi.mocked(db.job.updateMany).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const arg = calls[calls.length - 1]![0] as {
    data: { formData: Record<string, unknown> };
  };
  return arg.data.formData;
}

function photoMeta(url: string) {
  return { url, filename: `${url}.jpg`, size: 1, uploadedAt: "2026-04-20" };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.job.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("assignMultiFieldPhotos", () => {
  it("accepts a valid multi-photo assignment within cap", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1"), photoMeta("u2"), photoMeta("u3")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, ["u1", "u2", "u3"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({ [Q5]: ["u1", "u2", "u3"] });
    expect(saved[Q5]).toBe("u1"); // legacy mirror = first url
    expect(saved[REVIEWED_FLAG]).toBe(true);
  });

  it("rejects a non-multi-photo field id", async () => {
    const res = await assignMultiFieldPhotos("job-1", "customer_name", ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not a multi-photo target/i);
    // Early-reject: must not even read the DB.
    expect(db.job.findUnique).not.toHaveBeenCalled();
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an over-cap assignment without truncation", async () => {
    const tooMany = Array.from({ length: Q5_CAP + 1 }, (_, i) => `u${i}`);
    const res = await assignMultiFieldPhotos("job-1", Q5, tooMany);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too many photos/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a URL not present in job.photos", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, ["u1", "stranger"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown photo/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a non-DRAFT job", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "SUBMITTED",
      formData: { [Q5]: "sealed" },
      photos: [photoMeta("u1")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/only draft/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when updateMany returns count 0 (draft-flip between read and write)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1")],
    } as never);
    vi.mocked(db.job.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer editable/i);
  });

  it("deduplicates URLs while preserving first-occurrence order", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1"), photoMeta("u2")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, [
      "u2",
      "u1",
      "u2",
      "u1",
      "u2",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({ [Q5]: ["u2", "u1"] });
    expect(saved[Q5]).toBe("u2");
  });

  it("empty urls deletes the field entry and clears the legacy mirror", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "u1",
        [Q16]: "other",
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["u1", "u2"], [Q16]: ["other"] },
      },
      photos: [photoMeta("u1"), photoMeta("u2"), photoMeta("other")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, []);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Target field entry is removed from the map.
    expect(map).not.toHaveProperty(Q5);
    // Sibling field entry is preserved.
    expect(map[Q16]).toEqual(["other"]);
    // Legacy mirror is cleared to "".
    expect(saved[Q5]).toBe("");
  });

  it("sets __photoAssignmentsReviewed to true on successful write", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { unrelated: "keep" },
      photos: [photoMeta("u1")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, ["u1"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[REVIEWED_FLAG]).toBe(true);
    // Unrelated formData survives the write.
    expect(saved.unrelated).toBe("keep");
  });
});
