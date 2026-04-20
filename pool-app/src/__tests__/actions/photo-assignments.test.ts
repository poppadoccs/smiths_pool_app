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

import {
  assignMultiFieldPhotos,
  assignAdditionalPhotos,
} from "@/lib/actions/photo-assignments";
import { db } from "@/lib/db";
import {
  MULTI_PHOTO_CAPS,
  RESERVED_PHOTO_MAP_KEY,
  REVIEWED_FLAG,
  ADDITIONAL_PHOTOS_FIELD_ID,
  ADDITIONAL_PHOTOS_CAP,
} from "@/lib/multi-photo";

const Q5 = "5_picture_of_pool_and_spa_if_applicable";
const Q5_CAP = MULTI_PHOTO_CAPS[Q5]!; // 5, locked 2026-04-20
const Q16 = "16_photo_of_pool_pump";
const Q108 = ADDITIONAL_PHOTOS_FIELD_ID; // "108_additional_photos"

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

  it("accepts a payload exactly at cap for every multi-photo field", async () => {
    // Exercise every entry in MULTI_PHOTO_CAPS at its exact locked cap.
    // Catches a SUT with a stale hardcoded cap that happens to be lower:
    // the within-cap and over-cap tests only probe one field at a relative
    // offset, so a drift between code and MULTI_PHOTO_CAPS would slip past.
    for (const [fieldId, cap] of Object.entries(MULTI_PHOTO_CAPS)) {
      vi.clearAllMocks();
      vi.mocked(db.job.updateMany).mockResolvedValue({ count: 1 } as never);

      const urls = Array.from({ length: cap }, (_, i) => `u-${fieldId}-${i}`);
      vi.mocked(db.job.findUnique).mockResolvedValue({
        id: "job-1",
        status: "DRAFT",
        formData: null,
        photos: urls.map(photoMeta),
      } as never);

      const res = await assignMultiFieldPhotos("job-1", fieldId, urls);
      expect(res).toEqual({ success: true });

      const saved = writtenFormData();
      expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({ [fieldId]: urls });
      expect(saved[fieldId]).toBe(urls[0]);
      expect(saved[REVIEWED_FLAG]).toBe(true);
    }
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

    // Prove the guarded write path was actually attempted — not short-circuited
    // before the DB. A SUT that returned "no longer editable" without issuing
    // the DRAFT-guarded updateMany would silently pass the bare error check
    // above; this assertion forces the race-guard to be exercised.
    expect(db.job.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(db.job.updateMany).mock.calls[0]![0] as {
      where: { id: string; status: string };
    };
    expect(updateArg.where).toEqual({ id: "job-1", status: "DRAFT" });
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

describe("assignAdditionalPhotos (Q108)", () => {
  it("accepts a valid explicit Q108 selection within cap", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1"), photoMeta("u2"), photoMeta("u3")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["u1", "u2", "u3"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({
      [Q108]: ["u1", "u2", "u3"],
    });
    expect(saved[REVIEWED_FLAG]).toBe(true);
    // No legacy mirror for Q108 — the map entry is the only persisted shape.
    expect(saved).not.toHaveProperty(Q108);
  });

  it("accepts a payload exactly at cap (7, locked 2026-04-20)", async () => {
    const urls = Array.from(
      { length: ADDITIONAL_PHOTOS_CAP },
      (_, i) => `q108-${i}`,
    );
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: urls.map(photoMeta),
    } as never);

    const res = await assignAdditionalPhotos("job-1", urls);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({ [Q108]: urls });
  });

  it("rejects an over-cap payload without silent truncation", async () => {
    const tooMany = Array.from(
      { length: ADDITIONAL_PHOTOS_CAP + 1 },
      (_, i) => `q108-${i}`,
    );

    const res = await assignAdditionalPhotos("job-1", tooMany);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too many photos/i);
    // Over-cap must reject before any DB touch.
    expect(db.job.findUnique).not.toHaveBeenCalled();
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a URL not present in job.photos", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["u1", "stranger"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown photo/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a non-DRAFT job", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "SUBMITTED",
      formData: null,
      photos: [photoMeta("u1")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/only draft/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when updateMany returns count 0 and proves the guarded write was attempted", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1")],
    } as never);
    vi.mocked(db.job.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const res = await assignAdditionalPhotos("job-1", ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer editable/i);

    expect(db.job.updateMany).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(db.job.updateMany).mock.calls[0]![0] as {
      where: { id: string; status: string };
    };
    expect(updateArg.where).toEqual({ id: "job-1", status: "DRAFT" });
  });

  it("deduplicates URLs while preserving first-occurrence order", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1"), photoMeta("u2")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", [
      "u2",
      "u1",
      "u2",
      "u1",
      "u2",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({ [Q108]: ["u2", "u1"] });
  });

  it("empty urls deletes the Q108 entry and preserves sibling map entries", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: {
          [Q5]: ["u1", "u2"],
          [Q108]: ["x1", "x2"],
        },
      },
      photos: [
        photoMeta("u1"),
        photoMeta("u2"),
        photoMeta("x1"),
        photoMeta("x2"),
      ],
    } as never);

    const res = await assignAdditionalPhotos("job-1", []);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Q108 entry is removed from the map.
    expect(map).not.toHaveProperty(Q108);
    // Q5 entry written by a different action (assignMultiFieldPhotos) is
    // preserved — Q108's writer must not clobber sibling multi-photo fields.
    expect(map[Q5]).toEqual(["u1", "u2"]);
  });

  it("sets __photoAssignmentsReviewed to true and preserves unrelated formData", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { customer_name: "Alex", [REVIEWED_FLAG]: false },
      photos: [photoMeta("u1")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["u1"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[REVIEWED_FLAG]).toBe(true);
    expect(saved.customer_name).toBe("Alex");
  });
});

describe("one-photo-one-owner enforcement", () => {
  it("assigning a URL to Q108 steals it from Q5 and updates Q5's legacy mirror", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "shared", // pre-existing Q5 legacy mirror
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["shared", "q5-only"] },
      },
      photos: [photoMeta("shared"), photoMeta("q5-only")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["shared"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Q5 no longer owns "shared"; Q108 does.
    expect(map[Q5]).toEqual(["q5-only"]);
    expect(map[Q108]).toEqual(["shared"]);
    // Q5 legacy mirror was "shared"; post-steal it tracks urls[0] of the
    // remaining list, not the stolen URL.
    expect(saved[Q5]).toBe("q5-only");
  });

  it("assigning a URL to Q5 steals it from Q108 (no Q108 mirror to update)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q108]: ["shared", "q108-only"] },
      },
      photos: [photoMeta("shared"), photoMeta("q108-only")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q5, ["shared"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    expect(map[Q5]).toEqual(["shared"]);
    expect(map[Q108]).toEqual(["q108-only"]);
    expect(saved[Q5]).toBe("shared");
    // Q108 has no legacy mirror — stealing from it never touches a
    // formData[Q108] key.
    expect(saved).not.toHaveProperty(Q108);
  });

  it("stealing preserves sibling assignments that weren't involved in the move", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q16]: "a",
        [RESERVED_PHOTO_MAP_KEY]: {
          [Q5]: ["shared"],
          [Q16]: ["a", "b"],
        },
      },
      photos: [photoMeta("shared"), photoMeta("a"), photoMeta("b")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["shared"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Q5 lost its only URL — entry deleted, mirror cleared.
    expect(map).not.toHaveProperty(Q5);
    expect(saved[Q5]).toBe("");
    // Q16 was never involved in the move — its map entry AND its mirror
    // must remain exactly as they were.
    expect(map[Q16]).toEqual(["a", "b"]);
    expect(saved[Q16]).toBe("a");
    // Q108 new owner.
    expect(map[Q108]).toEqual(["shared"]);
  });

  it("reviewed flag stays true after a cross-owner move (Q5 → Q16)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "shared",
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["shared"] },
      },
      photos: [photoMeta("shared")],
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q16, ["shared"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[REVIEWED_FLAG]).toBe(true);
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    expect(map[Q16]).toEqual(["shared"]);
    expect(map).not.toHaveProperty(Q5);
    // Q5 mirror cleared after full steal.
    expect(saved[Q5]).toBe("");
    expect(saved[Q16]).toBe("shared");
  });

  it("no-op when the incoming URL is not owned elsewhere (regression guard)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["a", "b"] },
      },
      photos: [photoMeta("a"), photoMeta("b"), photoMeta("c")],
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["c"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Q5 wasn't touched by stealing — preserved verbatim.
    expect(map[Q5]).toEqual(["a", "b"]);
    expect(map[Q108]).toEqual(["c"]);
  });
});
