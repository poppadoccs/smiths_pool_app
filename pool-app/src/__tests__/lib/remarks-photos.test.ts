import { describe, it, expect } from "vitest";
import {
  readFieldPhotoUrls,
  remarksPhotoOwnerIdFor,
  REMARKS_FIELD_IDS,
  REMARKS_PHOTO_FIELD_IDS,
  RESERVED_PHOTO_MAP_KEY,
  ADDITIONAL_PHOTOS_FIELD_ID,
} from "@/lib/multi-photo";

// Narrow read-layer / prep-layer tests for the remarks-photo pipeline.
// Proves the helpers the PDF render path uses, without spinning up jsPDF
// or mocking fetch. If the helpers are correct and the pipeline wires
// them in the right place (see generate-pdf.ts), remarks photos reach
// the PDF render layer correctly.

describe("remarksPhotoOwnerIdFor", () => {
  it("returns `${id}_photos` for every remarks textarea id", () => {
    for (const textareaId of REMARKS_FIELD_IDS) {
      const ownerId = remarksPhotoOwnerIdFor(textareaId);
      expect(ownerId).toBe(`${textareaId}_photos`);
      // Every returned owner id must itself be in the enumerated set of
      // remarks-photo owner ids — guards against typos/drift.
      expect(REMARKS_PHOTO_FIELD_IDS.has(ownerId!)).toBe(true);
    }
  });

  it("returns null for non-remarks-textarea ids", () => {
    const notRemarks = [
      "5_picture_of_pool_and_spa_if_applicable", // multi-photo
      ADDITIONAL_PHOTOS_FIELD_ID, // Q108
      "customer_name", // ordinary text
      "pool_hero_photo", // hypothetical legacy single-slot
      "15_remarks_notes_photos", // synthetic owner id (not textarea)
      "", // empty
      "15_remarks_notes_X", // near-miss
    ];
    for (const id of notRemarks) {
      expect(remarksPhotoOwnerIdFor(id)).toBeNull();
    }
  });
});

describe("readFieldPhotoUrls via remarks-photo owner id", () => {
  it("returns the URLs persisted under the synthetic owner key", () => {
    const OWNER_15 = "15_remarks_notes_photos";
    const formData = {
      "15_remarks_notes": "some note text",
      [RESERVED_PHOTO_MAP_KEY]: {
        [OWNER_15]: ["url_a", "url_b"],
      },
    };
    const ownerId = remarksPhotoOwnerIdFor("15_remarks_notes");
    expect(ownerId).toBe(OWNER_15);
    expect(readFieldPhotoUrls(formData, ownerId!)).toEqual(["url_a", "url_b"]);
  });

  it("reads each remarks-photo owner independently — siblings don't leak", () => {
    const formData = {
      [RESERVED_PHOTO_MAP_KEY]: {
        "15_remarks_notes_photos": ["a1", "a2"],
        "33_remarks_notes_photos": ["b1"],
        "72_remarks_notes_photos": [],
      },
    };
    expect(readFieldPhotoUrls(formData, "15_remarks_notes_photos")).toEqual([
      "a1",
      "a2",
    ]);
    expect(readFieldPhotoUrls(formData, "33_remarks_notes_photos")).toEqual([
      "b1",
    ]);
    expect(readFieldPhotoUrls(formData, "72_remarks_notes_photos")).toEqual([]);
    expect(readFieldPhotoUrls(formData, "76_remarks_notes_photos")).toEqual([]);
  });

  it("returns [] when the synthetic owner entry is missing or malformed", () => {
    expect(readFieldPhotoUrls(null, "15_remarks_notes_photos")).toEqual([]);
    expect(readFieldPhotoUrls({}, "15_remarks_notes_photos")).toEqual([]);
    expect(
      readFieldPhotoUrls(
        { [RESERVED_PHOTO_MAP_KEY]: null },
        "15_remarks_notes_photos",
      ),
    ).toEqual([]);
    expect(
      readFieldPhotoUrls(
        {
          [RESERVED_PHOTO_MAP_KEY]: { "15_remarks_notes_photos": "not_array" },
        },
        "15_remarks_notes_photos",
      ),
    ).toEqual([]);
    expect(
      readFieldPhotoUrls(
        { [RESERVED_PHOTO_MAP_KEY]: { "15_remarks_notes_photos": [1, 2, 3] } },
        "15_remarks_notes_photos",
      ),
    ).toEqual([]); // non-string members filtered defensively
  });

  it("textarea note text and photos bucket coexist without collision", () => {
    // The textarea id `15_remarks_notes` holds the note string. The
    // synthetic id `15_remarks_notes_photos` holds the photo URL list.
    // The two keys are distinct — nothing the reader does can confuse
    // them.
    const formData = {
      "15_remarks_notes": "This is the note the worker typed in.",
      [RESERVED_PHOTO_MAP_KEY]: {
        "15_remarks_notes_photos": ["photo-url-1", "photo-url-2"],
      },
    };

    // Reading as textarea id (directly, not via remarks-photo helper)
    // returns the string — it's not a photo owner key.
    expect(formData["15_remarks_notes"]).toBe(
      "This is the note the worker typed in.",
    );

    // Reading as the synthetic photo owner id returns the URLs.
    expect(readFieldPhotoUrls(formData, "15_remarks_notes_photos")).toEqual([
      "photo-url-1",
      "photo-url-2",
    ]);

    // Reading the textarea id as if it were a photo field would return
    // [noteText] via the legacy-mirror fallback — BUT the PDF pipeline
    // never does this: it routes remarks reads through
    // remarksPhotoOwnerIdFor which transforms the textarea id into the
    // synthetic owner id before calling readFieldPhotoUrls. Document
    // that contract here so a future reader can't confuse the two.
    expect(remarksPhotoOwnerIdFor("15_remarks_notes")).toBe(
      "15_remarks_notes_photos",
    );
  });
});

describe("readFieldPhotoUrls regression for non-remarks owners", () => {
  it("multi-photo map entry still resolves from __photoAssignmentsByField first", () => {
    const formData = {
      "5_picture_of_pool_and_spa_if_applicable": "mirror_url",
      [RESERVED_PHOTO_MAP_KEY]: {
        "5_picture_of_pool_and_spa_if_applicable": ["map_a", "map_b"],
      },
    };
    // Map wins over legacy mirror — behavior unchanged by this task.
    expect(
      readFieldPhotoUrls(formData, "5_picture_of_pool_and_spa_if_applicable"),
    ).toEqual(["map_a", "map_b"]);
  });

  it("legacy single-slot mirror still falls through when no map entry exists", () => {
    const formData = { pool_hero_photo: "hero_url" };
    expect(readFieldPhotoUrls(formData, "pool_hero_photo")).toEqual([
      "hero_url",
    ]);
  });

  it("Q108 explicit selection reads via the map (no mirror by design)", () => {
    const formData = {
      [RESERVED_PHOTO_MAP_KEY]: {
        [ADDITIONAL_PHOTOS_FIELD_ID]: ["q108_1", "q108_2"],
      },
    };
    expect(readFieldPhotoUrls(formData, ADDITIONAL_PHOTOS_FIELD_ID)).toEqual([
      "q108_1",
      "q108_2",
    ]);
  });
});
