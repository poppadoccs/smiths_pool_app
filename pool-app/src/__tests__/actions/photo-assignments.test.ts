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
  assignRemarksFieldPhotos,
  savePhotoAssignments,
} from "@/lib/actions/photo-assignments";
import { db } from "@/lib/db";
import {
  MULTI_PHOTO_CAPS,
  RESERVED_PHOTO_MAP_KEY,
  REVIEWED_FLAG,
  ADDITIONAL_PHOTOS_FIELD_ID,
  ADDITIONAL_PHOTOS_CAP,
  REMARKS_PHOTO_CAP,
} from "@/lib/multi-photo";

const Q5 = "5_picture_of_pool_and_spa_if_applicable";
const Q5_CAP = MULTI_PHOTO_CAPS[Q5]!; // 5, locked 2026-04-20
const Q16 = "16_photo_of_pool_pump";
const Q108 = ADDITIONAL_PHOTOS_FIELD_ID; // "108_additional_photos"
const REMARKS_Q15 = "15_remarks_notes"; // textarea field id (note text)
const REMARKS_Q15_PHOTOS = "15_remarks_notes_photos"; // synthetic photo owner
const REMARKS_Q33_PHOTOS = "33_remarks_notes_photos"; // second remarks owner
const LEGACY_SINGLE = "pool_hero_photo"; // fictional template single-slot id

// Minimal FormField-like shapes for template mocking. The actions only
// read `id` and `type`, so the other keys are just placeholders.
function photoField(id: string) {
  return { id, type: "photo", label: id, required: false, order: 0 };
}
function textareaField(id: string) {
  return { id, type: "textarea", label: id, required: false, order: 0 };
}

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

  it("clears a legacy mirror-only owner when the URL is reassigned elsewhere", async () => {
    // Codex HIGH from the assignment-path review: a URL held ONLY via
    // formData[fid] (no map entry) could remain as a second owner after
    // assignAdditionalPhotos took it. The legacy-mirror sweep in Pass 2
    // of stealOneOwner is what closes this. Requires template-driven
    // iteration, so the findUnique now includes template.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "shared", // mirror only — no __photoAssignmentsByField entry
      },
      photos: [photoMeta("shared")],
      template: { fields: [photoField(Q5)] },
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["shared"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Q108 is the new owner.
    expect(map[Q108]).toEqual(["shared"]);
    // Q5 legacy mirror cleared — no duplicate ownership through the mirror.
    expect(saved[Q5]).toBe("");
  });

  it("clears a legacy single-slot photo mirror when stealing to assignMultiFieldPhotos", async () => {
    // Same Pass-2 proof, but from the multi-photo target direction and
    // against a non-multi-photo, non-remarks legacy single-slot field
    // (the kind savePhotoAssignments owns). Template iteration handles
    // this too, so ownership moves cleanly to Q16.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { [LEGACY_SINGLE]: "hero-url" },
      photos: [photoMeta("hero-url")],
      template: {
        fields: [photoField(LEGACY_SINGLE), photoField(Q16)],
      },
    } as never);

    const res = await assignMultiFieldPhotos("job-1", Q16, ["hero-url"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    expect(map[Q16]).toEqual(["hero-url"]);
    expect(saved[Q16]).toBe("hero-url");
    // Legacy single-slot mirror cleared.
    expect(saved[LEGACY_SINGLE]).toBe("");
  });

  it("clears a stale Q108 legacy mirror when the URL is stolen to a different owner", async () => {
    // Pre-Slice-1 contamination case: a historical job can carry a stale
    // single-URL string at formData["108_additional_photos"] written by
    // the old PhotoFieldInput → RHF → autosave path, even though the
    // post-slice assignAdditionalPhotos contract is map-only. If a later
    // action steals that URL to another owner, stealOneOwner Pass 2 MUST
    // clear the stale Q108 mirror — otherwise the URL ends up owned in
    // two places (new owner's map entry AND Q108's legacy mirror) and
    // readFieldPhotoUrls surfaces the duplicate at render time.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        // Stale Q108 legacy mirror — historical pre-slice shape.
        [Q108]: "legacy_q108_url",
        // No Q108 map entry; the contamination is mirror-only.
      },
      photos: [photoMeta("legacy_q108_url")],
      // Q108 must be in the template so it's enumerated by
      // templatePhotoFieldIds and reachable by Pass 2. Remarks-photo owner
      // ids are synthetic and never in the template.
      template: { fields: [photoField(Q108)] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "legacy_q108_url",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // New owner holds the URL under the map.
    expect(map[REMARKS_Q15_PHOTOS]).toEqual(["legacy_q108_url"]);
    // Stale Q108 mirror cleared — no duplicate ownership via the mirror.
    expect(saved[Q108]).toBe("");
    // Defensive: no Q108 map entry was invented.
    expect(map).not.toHaveProperty(Q108);
  });

  it("stealing from a remarks-photo owner preserves map-only semantics (no mirror write)", async () => {
    // Locked 2026-04-20: remarks-photo owner ids (*_remarks_notes_photos)
    // are map-only. If hasLegacyPhotoMirror ever regresses to include
    // remarks-photo ids, this test fails: stealing from the remarks-photo
    // map entry would erroneously write a mirror at the owner key.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: {
          [REMARKS_Q15_PHOTOS]: ["shared", "r2"],
        },
      },
      photos: [photoMeta("shared"), photoMeta("r2")],
      // Remarks-photo owner ids are synthetic — not in the template.
      // The textarea note field *_remarks_notes is what lives in the
      // template, and it holds note text, not photos.
      template: { fields: [textareaField(REMARKS_Q15)] },
    } as never);

    const res = await assignAdditionalPhotos("job-1", ["shared"]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Remarks-photo map entry filtered as expected.
    expect(map[REMARKS_Q15_PHOTOS]).toEqual(["r2"]);
    // No mirror write at the synthetic owner key (map-only semantics).
    expect(saved).not.toHaveProperty(REMARKS_Q15_PHOTOS);
    // Textarea note field (holds note text) is NEVER touched by a
    // photo action, regardless of steal state.
    expect(saved).not.toHaveProperty(REMARKS_Q15);
  });
});

describe("savePhotoAssignments map-awareness", () => {
  it("rejects an assignment that targets a map-backed multi-photo field", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "x",
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["x", "y"] },
      },
      photos: [photoMeta("other")],
      template: { fields: [photoField(Q5), photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await savePhotoAssignments("job-1", { other: Q5 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/map-backed/i);
    // No write should happen at all.
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an assignment that targets Q108 as a mirror target (Q108 is map-backed)", async () => {
    // The legacy "drain target" use of Q108 in savePhotoAssignments
    // continues to work (target === Q108_ID is skipped), but an admin
    // writing Q108 as a mirror-override target would have hit the old
    // unknown-target error. With map-awareness, the early continue still
    // applies, so this verifies Q108-as-drain-target did not regress.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {},
      photos: [photoMeta("drain-me")],
      template: { fields: [photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await savePhotoAssignments("job-1", {
      "drain-me": Q108, // Q108 as drain target — legacy semantic
    });
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    // Q108 was NOT persisted as a mirror (continue path); legacy single
    // slot stays cleared since no mirror target was given.
    expect(saved).not.toHaveProperty(Q108);
    expect(saved[LEGACY_SINGLE]).toBe("");
  });

  it("does not touch a map-backed field mirror even when no assignment targets it", async () => {
    // Regression guard for the MED divergence Codex flagged: empty
    // assignments must not "clear" Q5's mirror to "" while leaving
    // map[Q5] populated.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "x",
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["x", "y"] },
        [LEGACY_SINGLE]: "already_there",
      },
      photos: [photoMeta("whatever")],
      template: { fields: [photoField(Q5), photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await savePhotoAssignments("job-1", {});
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    // Q5 map and mirror BOTH preserved — savePhotoAssignments left
    // map-backed alone.
    expect(saved[Q5]).toBe("x");
    expect(saved[RESERVED_PHOTO_MAP_KEY]).toEqual({ [Q5]: ["x", "y"] });
    // Legacy single-slot field cleared (empty assignments → "").
    expect(saved[LEGACY_SINGLE]).toBe("");
  });

  it("still rewrites legacy (non-map-backed) photo field mirrors", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {},
      photos: [photoMeta("u1")],
      template: { fields: [photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await savePhotoAssignments("job-1", { u1: LEGACY_SINGLE });
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    expect(saved[LEGACY_SINGLE]).toBe("u1");
    expect(saved[REVIEWED_FLAG]).toBe(true);
  });

  it("rejects a remarks textarea field target (textarea is not a photo owner)", async () => {
    // Locked 2026-04-20: *_remarks_notes is a textarea that holds NOTE
    // TEXT. It is not a photo owner in any sense — not map-backed, not
    // in legacyPhotoFieldSet (template says type: "textarea"). An admin
    // attempting to write a photo URL into the textarea via the legacy
    // tool hits the "Unknown assignment target" error.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {},
      photos: [photoMeta("r1")],
      template: { fields: [textareaField(REMARKS_Q15)] },
    } as never);

    const res = await savePhotoAssignments("job-1", { r1: REMARKS_Q15 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown assignment target/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a remarks-photo owner target (map-backed via REMARKS_PHOTO_FIELD_IDS)", async () => {
    // The synthetic *_remarks_notes_photos owner is map-backed; legacy
    // path must refuse it so admin uses assignRemarksFieldPhotos.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {},
      photos: [photoMeta("r1")],
      // Synthetic owner is NOT in the template; the rejection fires via
      // the curated set, not via mapEntries observation.
      template: { fields: [textareaField(REMARKS_Q15)] },
    } as never);

    const res = await savePhotoAssignments("job-1", {
      r1: REMARKS_Q15_PHOTOS,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/map-backed/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  // --- Source-ownership rejection (HIGH fix for the duplicate-owner hole) ---

  it("rejects a map-backed source URL (Q5) reassigned to a legacy target", async () => {
    // Pre-state simulates a prior assignMultiFieldPhotos(Q5, ["u"]) landing
    // before this legacy call. map[Q5] owns "u" via the reserved map. If
    // savePhotoAssignments accepted the reassignment to a legacy mirror,
    // both Q5 and pool_hero_photo would report "u" as theirs.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "u",
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["u"] },
      },
      photos: [photoMeta("u")],
      template: { fields: [photoField(Q5), photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await savePhotoAssignments("job-1", { u: LEGACY_SINGLE });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/map-owned/i);
    expect(res.error).toContain(LEGACY_SINGLE);

    // Atomic rejection — no DB write, no mutation. map[Q5] is untouched
    // (in-memory mock state is not visible to the caller, but we assert
    // by construction: updateMany was never called).
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a map-backed source URL (Q108) reassigned to a legacy target", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q108]: ["u"] },
      },
      photos: [photoMeta("u")],
      template: { fields: [photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await savePhotoAssignments("job-1", { u: LEGACY_SINGLE });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/map-owned/i);
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects atomically when a mixed batch contains one legal and one map-owned URL", async () => {
    // The atomic guarantee matters: even though "u_free" is a legitimate
    // legacy assignment, "u_mapowned" is map-owned, so the whole call
    // fails. No partial mirror rewrite, no half-applied state.
    const SECONDARY = "secondary_photo";
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["u_mapowned"] },
      },
      photos: [photoMeta("u_free"), photoMeta("u_mapowned")],
      template: {
        fields: [
          photoField(Q5),
          photoField(LEGACY_SINGLE),
          photoField(SECONDARY),
        ],
      },
    } as never);

    const res = await savePhotoAssignments("job-1", {
      u_free: LEGACY_SINGLE,
      u_mapowned: SECONDARY,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/map-owned/i);
    // Atomic: no write at all, not even for the legal half of the batch.
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });
});

describe("assignRemarksFieldPhotos", () => {
  it("writes urls into __photoAssignmentsByField under the owner id with no mirror", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { [REMARKS_Q15]: "existing note text" },
      photos: [photoMeta("u1"), photoMeta("u2"), photoMeta("u3")],
      template: { fields: [textareaField(REMARKS_Q15)] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "u1",
      "u2",
      "u3",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Map entry written under the synthetic owner id.
    expect(map[REMARKS_Q15_PHOTOS]).toEqual(["u1", "u2", "u3"]);
    // No legacy mirror at the synthetic owner key.
    expect(saved).not.toHaveProperty(REMARKS_Q15_PHOTOS);
    // Textarea note text is NEVER touched by a photo action — the note
    // content survives unchanged alongside the photo map entry.
    expect(saved[REMARKS_Q15]).toBe("existing note text");
    expect(saved[REVIEWED_FLAG]).toBe(true);
  });

  it("one-photo-one-owner: clears a legacy single-slot mirror when a URL moves to a remarks-photo owner", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { [LEGACY_SINGLE]: "shared" },
      photos: [photoMeta("shared")],
      template: { fields: [photoField(LEGACY_SINGLE)] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "shared",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Remarks-photo owner owns "shared".
    expect(map[REMARKS_Q15_PHOTOS]).toEqual(["shared"]);
    // Legacy mirror cleared — single ownership.
    expect(saved[LEGACY_SINGLE]).toBe("");
  });

  it("one-photo-one-owner: steals from a map-backed multi-photo owner (Q5)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [Q5]: "shared",
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["shared", "q5-only"] },
      },
      photos: [photoMeta("shared"), photoMeta("q5-only")],
      template: { fields: [photoField(Q5)] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "shared",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    // Q5 lost "shared" from the map.
    expect(map[Q5]).toEqual(["q5-only"]);
    // Q5 mirror updated to the remaining urls[0] (multi-photo fields carry
    // a mirror; hasLegacyPhotoMirror returns true for Q5).
    expect(saved[Q5]).toBe("q5-only");
    // Remarks-photo owner now owns "shared".
    expect(map[REMARKS_Q15_PHOTOS]).toEqual(["shared"]);
  });

  it("one-photo-one-owner: steals from Q108", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q108]: ["shared", "q108-only"] },
      },
      photos: [photoMeta("shared"), photoMeta("q108-only")],
      template: { fields: [] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "shared",
    ]);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    expect(map[Q108]).toEqual(["q108-only"]);
    expect(map[REMARKS_Q15_PHOTOS]).toEqual(["shared"]);
    // Q108 has no mirror by design — no formData[Q108] written.
    expect(saved).not.toHaveProperty(Q108);
  });

  it("rejects an over-cap payload without silent truncation (cap 8)", async () => {
    const tooMany = Array.from(
      { length: REMARKS_PHOTO_CAP + 1 },
      (_, i) => `r-${i}`,
    );

    const res = await assignRemarksFieldPhotos(
      "job-1",
      REMARKS_Q15_PHOTOS,
      tooMany,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too many photos/i);
    // Over-cap must reject before any DB touch.
    expect(db.job.findUnique).not.toHaveBeenCalled();
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("accepts a payload exactly at cap for every remarks-photo owner", async () => {
    // Structural cap proof across all 8 remarks-photo owners — guards
    // against a drift between REMARKS_PHOTO_CAP and the action's cap
    // constant reference.
    const OWNERS = [
      "15_remarks_notes_photos",
      "33_remarks_notes_photos",
      "72_remarks_notes_photos",
      "76_remarks_notes_photos",
      "79_remarks_notes_photos",
      "83_remarks_notes_photos",
      "91_remarks_notes_photos",
      "102_remarks_notes_photos",
    ];
    for (const owner of OWNERS) {
      vi.clearAllMocks();
      vi.mocked(db.job.updateMany).mockResolvedValue({ count: 1 } as never);

      const urls = Array.from(
        { length: REMARKS_PHOTO_CAP },
        (_, i) => `${owner}-${i}`,
      );
      vi.mocked(db.job.findUnique).mockResolvedValue({
        id: "job-1",
        status: "DRAFT",
        formData: null,
        photos: urls.map(photoMeta),
        template: { fields: [] },
      } as never);

      const res = await assignRemarksFieldPhotos("job-1", owner, urls);
      expect(res).toEqual({ success: true });

      const saved = writtenFormData();
      const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
      expect(map[owner]).toEqual(urls);
      expect(saved).not.toHaveProperty(owner); // map-only, no mirror
    }
  });

  it("rejects a non-remarks-photo owner id (textarea id is NOT a remarks-photo owner)", async () => {
    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15, ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not a remarks-photo owner/i);
    // Early reject — must not read the DB.
    expect(db.job.findUnique).not.toHaveBeenCalled();
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary (non-remarks-photo) field id", async () => {
    const res = await assignRemarksFieldPhotos("job-1", Q5, ["u1"]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not a remarks-photo owner/i);
    expect(db.job.findUnique).not.toHaveBeenCalled();
    expect(db.job.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a URL not present in job.photos", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      photos: [photoMeta("u1")],
      template: { fields: [] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "u1",
      "stranger",
    ]);
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
      template: { fields: [] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "u1",
    ]);
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
      template: { fields: [] },
    } as never);
    vi.mocked(db.job.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, [
      "u1",
    ]);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer editable/i);
    expect(db.job.updateMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(db.job.updateMany).mock.calls[0]![0] as {
      where: { id: string; status: string };
    };
    expect(arg.where).toEqual({ id: "job-1", status: "DRAFT" });
  });

  it("empty urls deletes the owner entry while preserving sibling owners", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: {
          [REMARKS_Q15_PHOTOS]: ["u1", "u2"],
          [REMARKS_Q33_PHOTOS]: ["x1"],
        },
      },
      photos: [photoMeta("u1"), photoMeta("u2"), photoMeta("x1")],
      template: { fields: [] },
    } as never);

    const res = await assignRemarksFieldPhotos("job-1", REMARKS_Q15_PHOTOS, []);
    expect(res).toEqual({ success: true });

    const saved = writtenFormData();
    const map = saved[RESERVED_PHOTO_MAP_KEY] as Record<string, unknown>;
    expect(map).not.toHaveProperty(REMARKS_Q15_PHOTOS);
    // Sibling remarks-photo owner untouched.
    expect(map[REMARKS_Q33_PHOTOS]).toEqual(["x1"]);
  });
});
