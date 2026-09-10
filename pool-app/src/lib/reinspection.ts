import type { FormData, FormField } from "./forms";
import { parseSummaryItems, REINSPECTION_FIELD_ID } from "./summary";

export {
  REINSPECTION_FIELD_ID,
  RESERVED_REINSPECTION_SUMMARY_KEY,
} from "./summary";
export const REINSPECTION_LABEL = "109. Re-Inspection Summary";

/** Append the agreed optional section without renaming or reordering old fields. */
export function appendReinspectionSummary(input: FormField[]): {
  fields: FormField[];
  changed: boolean;
} {
  if (
    !Array.isArray(input) ||
    input.some(
      (field) =>
        !field ||
        typeof field.id !== "string" ||
        !field.id ||
        typeof field.label !== "string" ||
        !Number.isFinite(field.order),
    ) ||
    new Set(input.map((field) => field.id)).size !== input.length
  ) {
    throw new Error("Template fields must have unique IDs and valid ordering.");
  }

  // A different template must never receive the Pool/Spa-specific question.
  for (const [id, type] of [
    ["107_summary", "textarea"],
    ["108_additional_photos", "photo"],
  ]) {
    if (!input.some((field) => field.id === id && field.type === type)) {
      throw new Error(`Expected Pool/Spa template field ${id} (${type}).`);
    }
  }

  const candidates = input.filter(
    (field) =>
      field.id === REINSPECTION_FIELD_ID ||
      /^109(?:_|$)/.test(field.id) ||
      /^\s*109(?:[.\s]|$)/.test(field.label),
  );
  if (candidates.length > 0) {
    const existing = candidates[0];
    if (
      candidates.length !== 1 ||
      existing.id !== REINSPECTION_FIELD_ID ||
      existing.type !== "textarea" ||
      existing.required !== false ||
      existing.label !== REINSPECTION_LABEL ||
      input.some(
        (field) => field.id !== existing.id && field.order >= existing.order,
      )
    ) {
      throw new Error(
        "An incompatible question #109 already exists; review it before applying.",
      );
    }
    return { fields: structuredClone(input), changed: false };
  }

  return {
    fields: [
      ...structuredClone(input),
      {
        id: REINSPECTION_FIELD_ID,
        label: REINSPECTION_LABEL,
        type: "textarea",
        required: false,
        order: Math.max(...input.map((field) => field.order)) + 1,
      },
    ],
    changed: true,
  };
}

/** An unused optional section should not add an empty row to a report. */
export function hasReinspectionContent(
  formData: FormData | null | undefined,
  visiblePhotoUrls: readonly string[],
): boolean {
  const items = parseSummaryItems(formData, REINSPECTION_FIELD_ID);
  if (items !== null) {
    return items.some(
      (item) =>
        item.text.trim().length > 0 ||
        item.photos.some((url) => visiblePhotoUrls.includes(url)),
    );
  }
  const notes = formData?.[REINSPECTION_FIELD_ID];
  return typeof notes === "string" && notes.trim().length > 0;
}
