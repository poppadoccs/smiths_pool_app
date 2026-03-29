import { describe, it, expect } from "vitest";
import {
  buildFormSchema,
  getDefaultValues,
  DEFAULT_TEMPLATE,
  type FormTemplate,
} from "@/lib/forms";

describe("buildFormSchema", () => {
  const template: FormTemplate = {
    id: "test",
    name: "Test Form",
    version: 1,
    fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "nickname", label: "Nickname", type: "text", required: false },
      { id: "age", label: "Age", type: "number", required: true },
      { id: "height", label: "Height", type: "number", required: false },
      { id: "active", label: "Active", type: "checkbox", required: false },
      {
        id: "color",
        label: "Color",
        type: "select",
        required: true,
        options: ["Red", "Blue"],
      },
      { id: "bio", label: "Bio", type: "textarea", required: false },
    ],
  };

  const schema = buildFormSchema(template);

  it("accepts valid complete data", () => {
    const result = schema.safeParse({
      name: "Alice",
      nickname: "Ali",
      age: "25",
      height: "5.6",
      active: true,
      color: "Red",
      bio: "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid minimal data (optional fields empty)", () => {
    const result = schema.safeParse({
      name: "Alice",
      nickname: "",
      age: "25",
      height: "",
      active: false,
      color: "Blue",
      bio: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty required text field", () => {
    const result = schema.safeParse({
      name: "",
      nickname: "",
      age: "25",
      height: "",
      active: false,
      color: "Blue",
      bio: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const nameError = result.error.issues.find((i) => i.path[0] === "name");
      expect(nameError).toBeDefined();
    }
  });

  it("rejects empty required number field", () => {
    const result = schema.safeParse({
      name: "Alice",
      nickname: "",
      age: "",
      height: "",
      active: false,
      color: "Blue",
      bio: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const ageError = result.error.issues.find((i) => i.path[0] === "age");
      expect(ageError).toBeDefined();
    }
  });

  it("rejects non-numeric required number field", () => {
    const result = schema.safeParse({
      name: "Alice",
      nickname: "",
      age: "abc",
      height: "",
      active: false,
      color: "Blue",
      bio: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const ageError = result.error.issues.find((i) => i.path[0] === "age");
      expect(ageError?.message).toContain("must be a number");
    }
  });

  it("rejects non-numeric optional number field", () => {
    const result = schema.safeParse({
      name: "Alice",
      nickname: "",
      age: "25",
      height: "tall",
      active: false,
      color: "Blue",
      bio: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const heightError = result.error.issues.find(
        (i) => i.path[0] === "height"
      );
      expect(heightError?.message).toContain("must be a number");
    }
  });

  it("rejects empty required select field", () => {
    const result = schema.safeParse({
      name: "Alice",
      nickname: "",
      age: "25",
      height: "",
      active: false,
      color: "",
      bio: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const colorError = result.error.issues.find(
        (i) => i.path[0] === "color"
      );
      expect(colorError).toBeDefined();
    }
  });
});

describe("getDefaultValues", () => {
  const template: FormTemplate = {
    id: "test",
    name: "Test",
    version: 1,
    fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "count", label: "Count", type: "number", required: false },
      { id: "done", label: "Done", type: "checkbox", required: false },
      {
        id: "kind",
        label: "Kind",
        type: "select",
        required: true,
        options: ["A", "B"],
      },
      { id: "notes", label: "Notes", type: "textarea", required: false },
    ],
  };

  it("returns empty strings for text-like fields", () => {
    const defaults = getDefaultValues(template);
    expect(defaults.name).toBe("");
    expect(defaults.count).toBe("");
    expect(defaults.kind).toBe("");
    expect(defaults.notes).toBe("");
  });

  it("returns false for checkbox fields", () => {
    const defaults = getDefaultValues(template);
    expect(defaults.done).toBe(false);
  });

  it("has an entry for every field", () => {
    const defaults = getDefaultValues(template);
    expect(Object.keys(defaults)).toHaveLength(template.fields.length);
  });
});

describe("DEFAULT_TEMPLATE", () => {
  it("has a non-empty id and name", () => {
    expect(DEFAULT_TEMPLATE.id).toBeTruthy();
    expect(DEFAULT_TEMPLATE.name).toBeTruthy();
  });

  it("has at least 5 fields", () => {
    expect(DEFAULT_TEMPLATE.fields.length).toBeGreaterThanOrEqual(5);
  });

  it("every field has id, label, and type", () => {
    for (const field of DEFAULT_TEMPLATE.fields) {
      expect(field.id).toBeTruthy();
      expect(field.label).toBeTruthy();
      expect(["text", "number", "checkbox", "select", "textarea"]).toContain(
        field.type
      );
    }
  });

  it("select fields have options", () => {
    const selects = DEFAULT_TEMPLATE.fields.filter((f) => f.type === "select");
    for (const field of selects) {
      expect(field.options).toBeDefined();
      expect(field.options!.length).toBeGreaterThan(0);
    }
  });

  it("builds a valid schema", () => {
    const schema = buildFormSchema(DEFAULT_TEMPLATE);
    const defaults = getDefaultValues(DEFAULT_TEMPLATE);
    // Defaults alone should fail (required fields are empty)
    const result = schema.safeParse(defaults);
    expect(result.success).toBe(false);
  });
});
