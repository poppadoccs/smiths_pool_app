// The pure template transform behind scripts/apply-cassandra-template-edits.ts.
// The fixture mirrors the LIVE default template's target fields exactly
// (verified against the 2026-07-09 pre-edit dump) so a drift between this
// test and production reality fails loudly here instead of at apply time.
import { describe, it, expect } from "vitest";
import { applyCassandraEdits } from "../../../scripts/apply-cassandra-template-edits";
import type { FormField } from "@/lib/forms";

function liveLikeFields(): FormField[] {
  return [
    {
      id: "6_pool_filtration_pump",
      label: "6. Pool Filtration Pump",
      type: "radio",
      required: false,
      options: ["Yes", "No", "N/a"],
      order: 5,
    },
    {
      id: "7_pump_mfg",
      label: "7. Pump Mfg",
      type: "radio",
      required: false,
      placeholder: "Hayward, Pentair, Sta-Rite, Jandy, Jacuzzi, Other",
      options: ["Hayward", "Pentair", "Sta-Rite", "Jandy", "Jacuzzi", "Other"],
      order: 6,
    },
    {
      id: "8_pump_model",
      label: "8. Pump Model",
      type: "text",
      required: false,
      order: 7,
    },
    {
      id: "9_pump_hp",
      label: "9. Pump HP",
      type: "radio",
      required: false,
      options: ["1.0", "1.5", "2.0", "Variable", "Other"],
      order: 8,
    },
    {
      id: "34_cell_working_salt",
      label: "34. Cell working (Salt)",
      type: "radio",
      required: false,
      options: ["Yes", "No"],
      order: 33,
    },
    {
      id: "36_type",
      label: "36. Type",
      type: "radio",
      required: false,
      options: ["Salt", "Other"],
      order: 35,
    },
    {
      id: "70_leaks_visible",
      label: "70. Leaks visible",
      type: "radio",
      required: false,
      options: ["Yes", "No"],
      order: 69,
    },
    {
      id: "78_coping_loose_chipped_or_missing",
      label: "78. Coping Loose, Chipped or missing",
      type: "radio",
      required: false,
      options: ["Loose", "Chipped", "Missing", "N/a", "None"],
      order: 77,
    },
    {
      id: "90_vac_lock_installed",
      label: "90. Vac lock installed",
      type: "radio",
      required: false,
      options: ["Yes", "No"],
      order: 89,
    },
    {
      id: "107_summary",
      label: "107. Summary",
      type: "textarea",
      required: false,
      order: 106,
    },
  ];
}

describe("applyCassandraEdits", () => {
  it("applies every requested edit without changing any existing field id", () => {
    const before = liveLikeFields();
    const { fields: after, report } = applyCassandraEdits(before);

    // +2 new fields, all original ids preserved.
    expect(after).toHaveLength(before.length + 2);
    for (const f of before) {
      expect(after.some((a) => a.id === f.id)).toBe(true);
    }

    // #7 — main relabeled + Other→text; secondary inserted right after.
    const i7 = after.findIndex((f) => f.id === "7_pump_mfg");
    expect(after[i7].label).toBe("7. Pump Mfg — Main Pump");
    expect(after[i7].allowTextFor).toEqual(["Other"]);
    expect(after[i7].options).toEqual([
      "Hayward",
      "Pentair",
      "Sta-Rite",
      "Jandy",
      "Jacuzzi",
      "Other",
    ]);
    const f7b = after[i7 + 1];
    expect(f7b.id).toBe("7_pump_mfg_secondary");
    expect(f7b.type).toBe("radio");
    expect(f7b.required).toBe(false);
    expect(f7b.options).toEqual([
      "Hayward",
      "Pentair",
      "Sta-Rite",
      "Jandy",
      "Jacuzzi",
      "Other",
      "N/a",
    ]);
    expect(f7b.allowTextFor).toEqual(["Other"]);

    // #8 — main relabeled; secondary text field right after.
    const i8 = after.findIndex((f) => f.id === "8_pump_model");
    expect(after[i8].label).toBe("8. Pump Model — Main Pump");
    const f8b = after[i8 + 1];
    expect(f8b.id).toBe("8_pump_model_secondary");
    expect(f8b.type).toBe("text");
    expect(f8b.required).toBe(false);

    // #9 — Variable/Other free-text.
    expect(after.find((f) => f.id === "9_pump_hp")!.allowTextFor).toEqual([
      "Variable",
      "Other",
    ]);

    // #34 / #70 / #90 — N/a added.
    for (const id of [
      "34_cell_working_salt",
      "70_leaks_visible",
      "90_vac_lock_installed",
    ]) {
      expect(after.find((f) => f.id === id)!.options).toEqual([
        "Yes",
        "No",
        "N/a",
      ]);
    }

    // #36 — Chlorine added, Other→text.
    const f36 = after.find((f) => f.id === "36_type")!;
    expect(f36.options).toEqual(["Salt", "Chlorine", "Other"]);
    expect(f36.allowTextFor).toEqual(["Other"]);

    // #78 — Cracked in label AND options, id unchanged.
    const f78 = after.find(
      (f) => f.id === "78_coping_loose_chipped_or_missing",
    )!;
    expect(f78.label).toBe("78. Coping Loose, Chipped, Cracked or missing");
    expect(f78.options).toEqual([
      "Loose",
      "Chipped",
      "Cracked",
      "Missing",
      "N/a",
      "None",
    ]);

    // Orders re-densified 0..n-1 in array sequence.
    expect(after.map((f) => f.order)).toEqual(after.map((_, i) => i));

    // Untouched field really untouched (minus order densify).
    const f6 = after.find((f) => f.id === "6_pool_filtration_pump")!;
    expect(f6.label).toBe("6. Pool Filtration Pump");
    expect(f6.options).toEqual(["Yes", "No", "N/a"]);

    // Report covers all 10 edits.
    expect(report).toHaveLength(10);
  });

  it("syncs the placeholder mirror on option-edited radio fields", () => {
    const { fields: after } = applyCassandraEdits(liveLikeFields());
    expect(after.find((f) => f.id === "7_pump_mfg")!.placeholder).toBe(
      "Hayward, Pentair, Sta-Rite, Jandy, Jacuzzi, Other",
    );
  });

  it("does not mutate its input", () => {
    const before = liveLikeFields();
    const frozen = JSON.stringify(before);
    applyCassandraEdits(before);
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("refuses to double-apply (idempotency guard)", () => {
    const { fields: once } = applyCassandraEdits(liveLikeFields());
    expect(() => applyCassandraEdits(once)).toThrow(/already applied/);
  });

  it("aborts loudly when the live shape drifted from expectations", () => {
    const drifted = liveLikeFields().map((f) =>
      f.id === "36_type" ? { ...f, options: ["Salt", "Bromine", "Other"] } : f,
    );
    expect(() => applyCassandraEdits(drifted)).toThrow(/options mismatch/);

    const missing = liveLikeFields().filter((f) => f.id !== "9_pump_hp");
    expect(() => applyCassandraEdits(missing)).toThrow(/not found/);
  });
});
