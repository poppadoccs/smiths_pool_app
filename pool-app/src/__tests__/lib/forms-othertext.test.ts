// allowTextFor companion-text mechanism (client asks #5/#7/#36) and
// paired Main/Secondary field helpers.
import { describe, it, expect } from "vitest";
import {
  buildFormSchema,
  getDefaultValues,
  isSecondaryField,
  otherTextKey,
  resolveOtherText,
  secondaryFieldFor,
  splitPairedLabel,
  type FormField,
  type FormTemplate,
} from "@/lib/forms";

function radioField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "9_pump_hp",
    label: "9. Pump HP",
    type: "radio",
    required: false,
    options: ["1.0", "1.5", "2.0", "Variable", "Other"],
    allowTextFor: ["Variable", "Other"],
    order: 0,
    ...overrides,
  };
}

function template(fields: FormField[]): FormTemplate {
  return { id: "t", name: "T", version: 1, fields };
}

describe("otherTextKey", () => {
  it("derives a plain (non-reserved) sibling key", () => {
    expect(otherTextKey("9_pump_hp")).toBe("9_pump_hp_other_text");
    expect(otherTextKey("9_pump_hp").startsWith("__")).toBe(false);
  });
});

describe("buildFormSchema with allowTextFor", () => {
  it("adds an always-optional string entry for the companion key", () => {
    const schema = buildFormSchema(template([radioField()]));
    const parsed = schema.parse({
      "9_pump_hp": "Variable",
      "9_pump_hp_other_text": "2.7 THP",
    });
    expect(parsed["9_pump_hp_other_text"]).toBe("2.7 THP");
    // Companion never blocks submit-side validation even when empty.
    expect(() =>
      schema.parse({ "9_pump_hp": "", "9_pump_hp_other_text": "" }),
    ).not.toThrow();
  });

  it("adds no companion entry for fields without allowTextFor", () => {
    const schema = buildFormSchema(
      template([radioField({ allowTextFor: undefined })]),
    );
    const parsed = schema.parse({ "9_pump_hp": "Other" });
    expect("9_pump_hp_other_text" in parsed).toBe(false);
  });
});

describe("getDefaultValues with allowTextFor", () => {
  it("initializes the companion key to empty string (controlled input)", () => {
    const defaults = getDefaultValues(template([radioField()]));
    expect(defaults["9_pump_hp"]).toBe("");
    expect(defaults["9_pump_hp_other_text"]).toBe("");
  });
});

describe("paired field helpers", () => {
  const main = radioField({
    id: "7_pump_mfg",
    label: "7. Pump Mfg — Main Pump",
  });
  const secondary = radioField({
    id: "7_pump_mfg_secondary",
    label: "7. Pump Mfg — Secondary Pump",
  });
  const lone = radioField({ id: "9_pump_hp", label: "9. Pump HP" });
  const fields = [main, secondary, lone];

  it("secondaryFieldFor finds X_secondary for X, nothing otherwise", () => {
    expect(secondaryFieldFor(main, fields)?.id).toBe("7_pump_mfg_secondary");
    expect(secondaryFieldFor(lone, fields)).toBeUndefined();
    // A secondary has no secondary of its own.
    expect(secondaryFieldFor(secondary, fields)).toBeUndefined();
  });

  it("isSecondaryField is true only when the base field exists", () => {
    expect(isSecondaryField(secondary, fields)).toBe(true);
    expect(isSecondaryField(main, fields)).toBe(false);
    // Orphan *_secondary with no base is NOT treated as paired.
    const orphan = radioField({
      id: "99_orphan_secondary",
      label: "99. Orphan",
    });
    expect(isSecondaryField(orphan, [...fields, orphan])).toBe(false);
  });

  it("splitPairedLabel splits on the LAST em-dash separator", () => {
    expect(splitPairedLabel("7. Pump Mfg — Main Pump")).toEqual({
      title: "7. Pump Mfg",
      column: "Main Pump",
    });
    expect(splitPairedLabel("9. Pump HP")).toEqual({
      title: "9. Pump HP",
      column: "",
    });
  });
});

describe("resolveOtherText", () => {
  it("returns trimmed text when a trigger option is selected", () => {
    expect(
      resolveOtherText(radioField(), {
        "9_pump_hp": "Other",
        "9_pump_hp_other_text": "  Aqua-Flo XT  ",
      }),
    ).toBe("Aqua-Flo XT");
  });

  it("returns null for a non-trigger selection even with stale text", () => {
    expect(
      resolveOtherText(radioField(), {
        "9_pump_hp": "1.5",
        "9_pump_hp_other_text": "stale",
      }),
    ).toBeNull();
  });

  it("returns null when text is blank, formData missing, or field has no allowTextFor", () => {
    expect(
      resolveOtherText(radioField(), {
        "9_pump_hp": "Other",
        "9_pump_hp_other_text": "   ",
      }),
    ).toBeNull();
    expect(resolveOtherText(radioField(), null)).toBeNull();
    expect(
      resolveOtherText(radioField({ allowTextFor: undefined }), {
        "9_pump_hp": "Other",
        "9_pump_hp_other_text": "text",
      }),
    ).toBeNull();
  });
});
