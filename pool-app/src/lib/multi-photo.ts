// Shared constants + helpers for photo capacity across numbered photo
// questions. Per-field buffered caps are the customer source of truth
// (locked 2026-04-20). Every other photo field is single-slot and
// untouched by this module.
//
// Reserved-key convention: __-prefixed keys in formData are owned by
// dedicated server actions, never by RHF autosave.

// Multi-photo numbered questions (Q5, Q16, Q25, Q40, Q71) with their
// buffered per-field caps.
export const MULTI_PHOTO_CAPS: Readonly<Record<string, number>> = {
  "5_picture_of_pool_and_spa_if_applicable": 5,
  "16_photo_of_pool_pump": 5,
  "25_picture_of_cartridge": 4,
  "40_picture_if_leak_is_present_at_chlorinator": 5,
  "71_picture_of_leaks_on_valves_if_applicable": 6,
};

// Derived membership set — kept so call sites stay O(1) without
// re-reading Object.keys.
export const MULTI_PHOTO_FIELD_IDS: ReadonlySet<string> = new Set(
  Object.keys(MULTI_PHOTO_CAPS),
);

// Returns the per-field cap for a multi-photo question id, or undefined
// for any field that is not a multi-photo target. Callers use undefined
// to fall through to single-slot / remarks / Q108 handling.
export function getMultiPhotoCap(fieldId: string): number | undefined {
  return MULTI_PHOTO_CAPS[fieldId];
}

// Q108 "Additional Photos" — a separate single-field bucket with its
// own buffered cap. Not a member of MULTI_PHOTO_CAPS on purpose: its
// ownership and UI semantics differ (admin-chosen membership, no drain).
export const ADDITIONAL_PHOTOS_FIELD_ID = "108_additional_photos";
export const ADDITIONAL_PHOTOS_CAP = 7;

// Remarks/notes fields — 8 textareas that also accept photo attachments
// in the new shape. Canonical ids verified against the extracted form
// template (scripts/extraction-output.json).
export const REMARKS_FIELD_IDS: ReadonlySet<string> = new Set([
  "15_remarks_notes",
  "33_remarks_notes",
  "72_remarks_notes",
  "76_remarks_notes",
  "79_remarks_notes",
  "83_remarks_notes",
  "91_remarks_notes",
  "102_remarks_notes",
]);

// Uniform buffered cap across every remarks/notes field.
export const REMARKS_PHOTO_CAP = 8;

// Remarks PHOTO owner ids (locked 2026-04-20). Separate from the textarea
// ids in REMARKS_FIELD_IDS because the product decision is:
//   - `*_remarks_notes`        — textarea value (note text), never photos
//   - `*_remarks_notes_photos` — synthetic photo-owner key, map-only
// The `_photos`-suffixed ids are NOT template fields; they live only as
// keys inside __photoAssignmentsByField and are written by the dedicated
// assignRemarksFieldPhotos action. No legacy mirror.
export const REMARKS_PHOTO_FIELD_IDS: ReadonlySet<string> = new Set([
  "15_remarks_notes_photos",
  "33_remarks_notes_photos",
  "72_remarks_notes_photos",
  "76_remarks_notes_photos",
  "79_remarks_notes_photos",
  "83_remarks_notes_photos",
  "91_remarks_notes_photos",
  "102_remarks_notes_photos",
]);

// Maps a remarks TEXTAREA field id (e.g. "15_remarks_notes") to the
// synthetic remarks-PHOTO owner id (e.g. "15_remarks_notes_photos"), or
// returns null when the argument is not a remarks textarea. The synthetic
// owner ids are the keys under which the reserved map holds photo URLs
// attached to each remarks section.
//
// Convention is fixed: `${fieldId}_photos`. The REMARKS_PHOTO_FIELD_IDS
// enumeration is the source of truth for which synthetic ids exist, and
// this helper is a typed bridge from the textarea id to that set.
export function remarksPhotoOwnerIdFor(fieldId: string): string | null {
  if (!REMARKS_FIELD_IDS.has(fieldId)) return null;
  const ownerId = `${fieldId}_photos`;
  return REMARKS_PHOTO_FIELD_IDS.has(ownerId) ? ownerId : null;
}

export const RESERVED_PHOTO_MAP_KEY = "__photoAssignmentsByField";
export const REVIEWED_FLAG = "__photoAssignmentsReviewed";

// Reserved marker written by createEditableCopy into the copy's formData.
// Holds the source job id so the copy's editable UI can detect that its
// photo blobs are SHARED with a SUBMITTED source and must not be deleted
// destructively. The guard is UI-level only for this slice — the photos
// action surface is unchanged; a future resend/blob-ownership slice will
// replace this with true per-job blob ownership (copy-on-write or
// reference counting).
export const SOURCE_JOB_ID_KEY = "__sourceJobId";

// True when the given formData carries the editable-copy marker.
export function isEditableCopy(
  formData: Record<string, unknown> | null | undefined,
): boolean {
  if (!formData) return false;
  const v = formData[SOURCE_JOB_ID_KEY];
  return typeof v === "string" && v.length > 0;
}

// Resolves a field's photo URLs across the new map shape and the legacy
// single-string mirror. Priority:
//   1. formData["__photoAssignmentsByField"][fieldId] (new shape)
//   2. formData[fieldId] as non-empty string (legacy mirror)
//   3. []
//
// Returns string URLs only — non-string array members are filtered out
// defensively so a malformed DB row never crashes a renderer.
export function readFieldPhotoUrls(
  formData: Record<string, unknown> | null | undefined,
  fieldId: string,
): string[] {
  if (!formData) return [];

  const map = formData[RESERVED_PHOTO_MAP_KEY];
  if (map && typeof map === "object" && !Array.isArray(map)) {
    const entry = (map as Record<string, unknown>)[fieldId];
    if (Array.isArray(entry)) {
      return entry.filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      );
    }
  }

  const legacy = formData[fieldId];
  if (typeof legacy === "string" && legacy.length > 0) {
    return [legacy];
  }

  return [];
}
