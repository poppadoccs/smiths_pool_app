// buildPhotoRemovalPatch — deletePhoto's formData ghost-reference cleanup
// (ultrareview bug_002). Patch semantics: only changed keys, null = no-op.
import { describe, it, expect } from "vitest";
import {
  buildPhotoRemovalPatch,
  RESERVED_PHOTO_MAP_KEY,
} from "@/lib/multi-photo";
import {
  RESERVED_SUMMARY_KEY,
  RESERVED_REINSPECTION_SUMMARY_KEY,
} from "@/lib/summary";

const Q5 = "5_picture_of_pool_and_spa_if_applicable";
const Q16 = "16_photo_of_pool_pump";

describe("buildPhotoRemovalPatch", () => {
  it("returns null when the URL is unreferenced (no write needed)", () => {
    expect(
      buildPhotoRemovalPatch({ customer: "x" }, "http://p/gone", [Q5]),
    ).toBeNull();
    expect(buildPhotoRemovalPatch(null, "http://p/gone", [Q5])).toBeNull();
  });

  it("strips the URL from map buckets, deleting buckets it empties", () => {
    const patch = buildPhotoRemovalPatch(
      {
        [RESERVED_PHOTO_MAP_KEY]: {
          [Q5]: ["http://p/gone"],
          [Q16]: ["http://p/keep", "http://p/gone"],
        },
      },
      "http://p/gone",
      [],
    )!;
    expect(patch[RESERVED_PHOTO_MAP_KEY]).toEqual({
      [Q16]: ["http://p/keep"],
    });
  });

  it("clears legacy mirrors only for photo fields holding the URL", () => {
    const patch = buildPhotoRemovalPatch(
      { [Q5]: "http://p/gone", [Q16]: "http://p/other", note: "http://p/gone" },
      "http://p/gone",
      [Q5, Q16],
    )!;
    expect(patch[Q5]).toBe("");
    expect(patch).not.toHaveProperty(Q16);
    // Non-photo keys are never touched even if their text equals the URL.
    expect(patch).not.toHaveProperty("note");
  });

  it("filters the URL out of summary bullet photo lists, preserving text", () => {
    const patch = buildPhotoRemovalPatch(
      {
        [RESERVED_SUMMARY_KEY]: [
          { text: "algae", photos: ["http://p/gone", "http://p/keep"] },
          { text: "filter", photos: [] },
        ],
      },
      "http://p/gone",
      [],
    )!;
    expect(patch[RESERVED_SUMMARY_KEY]).toEqual([
      { text: "algae", photos: ["http://p/keep"] },
      { text: "filter", photos: [] },
    ]);
  });

  it("covers all three loci at once and omits untouched keys", () => {
    const patch = buildPhotoRemovalPatch(
      {
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["http://p/gone"] },
        [Q5]: "http://p/gone",
        [RESERVED_SUMMARY_KEY]: [{ text: "t", photos: ["http://p/gone"] }],
        untouched_text: "stays out of the patch",
      },
      "http://p/gone",
      [Q5],
    )!;
    expect(Object.keys(patch).sort()).toEqual(
      [RESERVED_PHOTO_MAP_KEY, Q5, RESERVED_SUMMARY_KEY].sort(),
    );
  });
  it("removes a deleted photo from both summaries while preserving each section's text and other photos", () => {
    const patch = buildPhotoRemovalPatch(
      {
        [RESERVED_SUMMARY_KEY]: [
          { text: "Original", photos: ["gone", "original-kept"] },
        ],
        [RESERVED_REINSPECTION_SUMMARY_KEY]: [
          { text: "Reinspection", photos: ["reinspection-kept", "gone"] },
        ],
      },
      "gone",
      [],
    )!;
    expect(patch).toEqual({
      [RESERVED_SUMMARY_KEY]: [{ text: "Original", photos: ["original-kept"] }],
      [RESERVED_REINSPECTION_SUMMARY_KEY]: [
        { text: "Reinspection", photos: ["reinspection-kept"] },
      ],
    });
  });
});
