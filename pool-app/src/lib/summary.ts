// Structured summary items for Q107 and optional Q109. Both use the same
// editor, validation and report layout, with independent reserved keys.
// A legacy plain string still renders when parseSummaryItems returns null.
//
// Reserved-key convention: each summary's reserved key is owned by the
// dedicated saveSummaryItems server action (Task 8). RHF autosave must
// never write this key. See plan 260417-mpf.

export type SummaryItem = { text: string; photos: string[] };

export const RESERVED_SUMMARY_KEY = "__summary_items";

// The template field that hosts the structured summary editor. The legacy
// text blob lives at formData[SUMMARY_FIELD_ID]; structured items live at
// formData[RESERVED_SUMMARY_KEY].
export const SUMMARY_FIELD_ID = "107_summary";
export const REINSPECTION_FIELD_ID = "109_reinspection_summary";
export const RESERVED_REINSPECTION_SUMMARY_KEY = "__reinspection_summary_items";
export const SUMMARY_FIELD_IDS = [
  SUMMARY_FIELD_ID,
  REINSPECTION_FIELD_ID,
] as const;
export type SummaryFieldId = (typeof SUMMARY_FIELD_IDS)[number];

export function isSummaryFieldId(fieldId: string): fieldId is SummaryFieldId {
  return fieldId === SUMMARY_FIELD_ID || fieldId === REINSPECTION_FIELD_ID;
}

// Each editor owns just its own reserved key. Never accept an arbitrary
// client-supplied JSON key in the summary writer.
export function summaryKeyFor(fieldId: string): string | undefined {
  if (fieldId === SUMMARY_FIELD_ID) return RESERVED_SUMMARY_KEY;
  if (fieldId === REINSPECTION_FIELD_ID)
    return RESERVED_REINSPECTION_SUMMARY_KEY;
  return undefined;
}

// Hard cap on a single item's text — generous for field notes, small
// enough to keep the PDF/email payload sane.
export const SUMMARY_TEXT_MAX_LENGTH = 4000;

// Capacity policy (customer source of truth, locked 2026-04-20):
//   per-item cap = hard limit per individual summary item
//   total cap    = hard limit across all summary items combined
//   soft warn    = inline UI warning threshold, non-blocking
export const SUMMARY_PER_ITEM_CAP = 8;
export const SUMMARY_PHOTO_TOTAL_CAP = 30;
export const SUMMARY_PHOTO_SOFT_WARN = 24;

// Parses the reserved __summary_items key into a SummaryItem[] or returns
// null when the value is absent or not a well-formed array of items.
//   null  → legacy path (PDF renders formData["107_summary"] as a text blob)
//   []    → structured path with zero items (user cleared their list)
//   [...] → structured path with items
//
// Item shape: { text: string, photos: string[] }. Any malformed item
// drops the whole array to null so a corrupt row never renders half.
export function parseSummaryItems(
  formData: Record<string, unknown> | null | undefined,
  fieldId: SummaryFieldId = SUMMARY_FIELD_ID,
): SummaryItem[] | null {
  if (!formData) return null;

  const key = summaryKeyFor(fieldId);
  const raw = key ? formData[key] : undefined;
  if (!Array.isArray(raw)) return null;

  const out: SummaryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const text = rec.text;
    const photos = rec.photos;
    if (typeof text !== "string") return null;
    if (!Array.isArray(photos)) return null;
    if (!photos.every((u) => typeof u === "string")) return null;
    out.push({ text, photos: photos as string[] });
  }

  return out;
}

export function countSummaryPhotos(items: SummaryItem[]): number {
  let n = 0;
  for (const item of items) n += item.photos.length;
  return n;
}

export function collectSummaryPhotoUrls(items: SummaryItem[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    for (const u of item.photos) urls.push(u);
  }
  return urls;
}
