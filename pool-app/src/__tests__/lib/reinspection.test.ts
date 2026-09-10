import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  appendReinspectionSummary,
  hasReinspectionContent,
  REINSPECTION_FIELD_ID,
  REINSPECTION_LABEL,
  RESERVED_REINSPECTION_SUMMARY_KEY,
} from "@/lib/reinspection";
import { buildFormSchema, getDefaultValues, type FormField } from "@/lib/forms";

function originalFields(): FormField[] {
  const extraction = JSON.parse(
    readFileSync("scripts/extraction-output.json", "utf8"),
  );
  return extraction.template.fields.filter(
    (field: FormField) => field.id !== REINSPECTION_FIELD_ID,
  );
}

describe("optional Q109 template update", () => {
  it("appends exactly one optional textarea and preserves all existing fields verbatim", () => {
    const before = originalFields();
    const snapshot = structuredClone(before);
    const result = appendReinspectionSummary(before);
    expect(result.changed).toBe(true);
    expect(result.fields.slice(0, -1)).toEqual(snapshot);
    expect(before).toEqual(snapshot);
    expect(result.fields.at(-1)).toMatchObject({
      id: REINSPECTION_FIELD_ID,
      label: REINSPECTION_LABEL,
      type: "textarea",
      required: false,
    });
    expect(result.fields.at(-1)!.order).toBeGreaterThan(
      Math.max(...before.map((f) => f.order)),
    );
  });

  it("is idempotent and never duplicates an already applied #109", () => {
    const first = appendReinspectionSummary(originalFields());
    const second = appendReinspectionSummary(first.fields);
    expect(second.changed).toBe(false);
    expect(second.fields).toEqual(first.fields);
  });

  it("refuses a different template, duplicate IDs, and an existing conflicting #109", () => {
    expect(() => appendReinspectionSummary([])).toThrow(/Expected Pool\/Spa/);
    const original = originalFields();
    expect(() => appendReinspectionSummary([...original, original[0]])).toThrow(
      /unique IDs/,
    );
    expect(() =>
      appendReinspectionSummary([
        ...original,
        {
          id: "109_old_field",
          label: "109. Old field",
          type: "text",
          required: false,
          order: 200,
        },
      ]),
    ).toThrow(/incompatible/);
    const applied = appendReinspectionSummary(original).fields;
    applied.at(-1)!.required = true;
    expect(() => appendReinspectionSummary(applied)).toThrow(/incompatible/);
  });

  it("defaults a previously missing Q109 to blank, accepts blank, and accepts multiline notes", () => {
    const field = appendReinspectionSummary(originalFields()).fields.at(-1)!;
    const template = { id: "test", name: "Test", version: 1, fields: [field] };
    const schema = buildFormSchema(template);
    expect(schema.safeParse(getDefaultValues(template)).success).toBe(true);
    expect(schema.safeParse({ [REINSPECTION_FIELD_ID]: "" }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({
        [REINSPECTION_FIELD_ID]: "Leak repaired.\nRetested successfully.",
      }).success,
    ).toBe(true);
  });

  it("omits unused reports but keeps notes-only and photos-only reinspections", () => {
    expect(hasReinspectionContent(null, [])).toBe(false);
    expect(
      hasReinspectionContent({ [REINSPECTION_FIELD_ID]: " \n " }, []),
    ).toBe(false);
    expect(
      hasReinspectionContent({ [REINSPECTION_FIELD_ID]: "Passed" }, []),
    ).toBe(true);
    expect(hasReinspectionContent({}, ["unrelated-job-photo"])).toBe(false);
    expect(
      hasReinspectionContent(
        {
          [RESERVED_REINSPECTION_SUMMARY_KEY]: [
            { text: "", photos: ["photo"] },
          ],
        },
        ["photo"],
      ),
    ).toBe(true);
    expect(
      hasReinspectionContent(
        {
          [RESERVED_REINSPECTION_SUMMARY_KEY]: [
            { text: "", photos: ["photo"] },
          ],
        },
        [],
      ),
    ).toBe(false);
  });
});
