// Cassandra's requested template edits (PoolSmith's email, May 18) applied
// to the LIVE default "Pool/Spa Inspection" template — DB-only guarded fix
// in the phase2/phase4 script tradition:
//
//   - READ-only by default: runs every preflight assert, prints the full
//     before/after diff, and stops. Pass --apply to write.
//   - Pass --target <templateId> to apply to a different template row
//     (used to rehearse on a disposable [TEST] copy before the live row).
//   - Backs up the target row to C:\Users\renea\pool-app-backups BEFORE
//     writing. Field ids are NEVER changed (the template-editor UI would
//     regenerate them from labels — that path must not be used for this).
//
// Edits (question numbers = the numbers embedded in field labels):
//   #7  split into Main Pump (existing id, relabeled) + Secondary Pump
//       (new field) — same options; both get Other→free-text
//   #8  same split for Pump Model (text fields)
//   #9  Variable/Other → free-text
//   #34 add "N/a"
//   #36 add "Chlorine"; Other → free-text
//   #70 add "N/a"
//   #78 add "Cracked" to label + options
//   #90 add "N/a"
//
// Run: cd pool-app && npx tsx scripts/apply-cassandra-template-edits.ts [--apply] [--target <id>]

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { mkdirSync, writeFileSync } from "fs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import type { FormField } from "../src/lib/forms";

const LIVE_TEMPLATE_ID = "cmngz7mhr0000k8s6792itaz4"; // Pool/Spa Inspection (isDefault)
const BACKUP_DIR = "C:\\Users\\renea\\pool-app-backups";

// --- The transform, pure so tests/fixtures apply IDENTICAL logic ---------

type EditReport = { field: string; change: string }[];

class EditError extends Error {}

function expectField(fields: FormField[], id: string, type: string): FormField {
  const f = fields.find((x) => x.id === id);
  if (!f) throw new EditError(`Field ${id} not found`);
  if (f.type !== type)
    throw new EditError(`Field ${id} has type ${f.type}, expected ${type}`);
  return f;
}

function expectOptions(f: FormField, expected: string[]) {
  const got = JSON.stringify(f.options ?? []);
  const want = JSON.stringify(expected);
  if (got !== want)
    throw new EditError(
      `Field ${f.id} options mismatch.\n  expected ${want}\n  got      ${got}`,
    );
}

const PUMP_MFG_OPTIONS = [
  "Hayward",
  "Pentair",
  "Sta-Rite",
  "Jandy",
  "Jacuzzi",
  "Other",
];

export function applyCassandraEdits(input: FormField[]): {
  fields: FormField[];
  report: EditReport;
} {
  // Deep copy — never mutate caller state.
  const fields: FormField[] = JSON.parse(JSON.stringify(input));
  const report: EditReport = [];

  // Idempotency guard: refuse a second run instead of double-inserting.
  if (fields.some((f) => f.id === "7_pump_mfg_secondary")) {
    throw new EditError(
      "Edits appear to be already applied (7_pump_mfg_secondary exists). Refusing to re-apply.",
    );
  }

  // --- #7 Pump Mfg → Main Pump + Secondary Pump, Other w/ text ---
  const f7 = expectField(fields, "7_pump_mfg", "radio");
  expectOptions(f7, PUMP_MFG_OPTIONS);
  if (f7.label !== "7. Pump Mfg")
    throw new EditError(`Unexpected #7 label: "${f7.label}"`);
  f7.label = "7. Pump Mfg — Main Pump";
  f7.allowTextFor = ["Other"];
  report.push({
    field: "7_pump_mfg",
    change: 'label → "7. Pump Mfg — Main Pump"; Other → free-text',
  });

  const f7b: FormField = {
    id: "7_pump_mfg_secondary",
    label: "7. Pump Mfg — Secondary Pump",
    type: "radio",
    required: false,
    // Same options as Main Pump + "N/a" so a mis-tap is recoverable
    // (radios can't be deselected) and "no secondary pump" is explicit.
    options: [...PUMP_MFG_OPTIONS, "N/a"],
    allowTextFor: ["Other"],
    order: 0, // re-densified below
  };
  fields.splice(fields.findIndex((f) => f.id === "7_pump_mfg") + 1, 0, f7b);
  report.push({
    field: "7_pump_mfg_secondary",
    change: "NEW radio — same mfg options + N/a; Other → free-text",
  });

  // --- #8 Pump Model → Main Pump + Secondary Pump (text) ---
  const f8 = expectField(fields, "8_pump_model", "text");
  if (f8.label !== "8. Pump Model")
    throw new EditError(`Unexpected #8 label: "${f8.label}"`);
  f8.label = "8. Pump Model — Main Pump";
  report.push({
    field: "8_pump_model",
    change: 'label → "8. Pump Model — Main Pump"',
  });

  const f8b: FormField = {
    id: "8_pump_model_secondary",
    label: "8. Pump Model — Secondary Pump",
    type: "text",
    required: false,
    order: 0, // re-densified below
  };
  fields.splice(fields.findIndex((f) => f.id === "8_pump_model") + 1, 0, f8b);
  report.push({
    field: "8_pump_model_secondary",
    change: "NEW text field",
  });

  // --- #9 Pump HP: free text on Variable/Other ---
  const f9 = expectField(fields, "9_pump_hp", "radio");
  expectOptions(f9, ["1.0", "1.5", "2.0", "Variable", "Other"]);
  f9.allowTextFor = ["Variable", "Other"];
  report.push({
    field: "9_pump_hp",
    change: "Variable/Other → free-text",
  });

  // --- #34 Cell working (Salt): add N/a ---
  const f34 = expectField(fields, "34_cell_working_salt", "radio");
  expectOptions(f34, ["Yes", "No"]);
  f34.options = ["Yes", "No", "N/a"];
  report.push({ field: "34_cell_working_salt", change: "options + N/a" });

  // --- #36 Type: add Chlorine; Other w/ text ---
  const f36 = expectField(fields, "36_type", "radio");
  expectOptions(f36, ["Salt", "Other"]);
  f36.options = ["Salt", "Chlorine", "Other"];
  f36.allowTextFor = ["Other"];
  report.push({
    field: "36_type",
    change: "options + Chlorine; Other → free-text",
  });

  // --- #70 Leaks visible: add N/a ---
  const f70 = expectField(fields, "70_leaks_visible", "radio");
  expectOptions(f70, ["Yes", "No"]);
  f70.options = ["Yes", "No", "N/a"];
  report.push({ field: "70_leaks_visible", change: "options + N/a" });

  // --- #78 Coping: add Cracked to label + options ---
  const f78 = expectField(
    fields,
    "78_coping_loose_chipped_or_missing",
    "radio",
  );
  expectOptions(f78, ["Loose", "Chipped", "Missing", "N/a", "None"]);
  if (f78.label !== "78. Coping Loose, Chipped or missing")
    throw new EditError(`Unexpected #78 label: "${f78.label}"`);
  f78.label = "78. Coping Loose, Chipped, Cracked or missing";
  f78.options = ["Loose", "Chipped", "Cracked", "Missing", "N/a", "None"];
  report.push({
    field: "78_coping_loose_chipped_or_missing",
    change: "label + options + Cracked (id UNCHANGED)",
  });

  // --- #90 Vac lock installed: add N/a ---
  const f90 = expectField(fields, "90_vac_lock_installed", "radio");
  expectOptions(f90, ["Yes", "No"]);
  f90.options = ["Yes", "No", "N/a"];
  report.push({ field: "90_vac_lock_installed", change: "options + N/a" });

  // Sync placeholders that mirror the options list (display-only metadata).
  for (const f of fields) {
    if (
      (f.type === "radio" || f.type === "select") &&
      f.options &&
      typeof f.placeholder === "string" &&
      f.placeholder.length > 0
    ) {
      f.placeholder = f.options.join(", ");
    }
  }

  // Re-densify order after the two inserts (both renderers sort by order).
  fields.forEach((f, i) => {
    f.order = i;
  });

  return { fields, report };
}

// --- Runner ---------------------------------------------------------------

async function main() {
  const apply = process.argv.includes("--apply");
  const targetFlag = process.argv.indexOf("--target");
  const targetId =
    targetFlag >= 0 ? process.argv[targetFlag + 1] : LIVE_TEMPLATE_ID;
  if (!targetId) throw new Error("--target requires a template id");

  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const tpl = await prisma.formTemplate.findUnique({
      where: { id: targetId },
    });
    if (!tpl) throw new Error(`Template ${targetId} not found`);

    console.log(
      `Target: ${tpl.id} "${tpl.name}" (isDefault=${tpl.isDefault}, ${(tpl.fields as unknown[]).length} fields)`,
    );
    if (targetId === LIVE_TEMPLATE_ID) {
      if (!tpl.isDefault)
        throw new Error("Live template is unexpectedly not isDefault — abort");
      if ((tpl.fields as unknown[]).length !== 108)
        throw new Error(
          `Live template has ${(tpl.fields as unknown[]).length} fields, expected 108 — abort`,
        );
    }

    const before = tpl.fields as FormField[];
    const { fields: after, report } = applyCassandraEdits(before);

    console.log("\n--- Planned changes ---");
    for (const r of report) console.log(`  ${r.field}: ${r.change}`);
    console.log(
      `\nField count: ${before.length} → ${after.length} (expected +2)`,
    );
    if (after.length !== before.length + 2)
      throw new Error("Field-count delta is not +2 — abort");

    if (!apply) {
      console.log(
        "\nDRY RUN — no writes. Re-run with --apply to write these changes.",
      );
      return;
    }

    // Backup the target row before writing.
    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const backupPath = `${BACKUP_DIR}\\template-${tpl.id}-pre-apply-${stamp}.json`;
    writeFileSync(backupPath, JSON.stringify(tpl, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    await prisma.formTemplate.update({
      where: { id: tpl.id },
      data: { fields: after as unknown as object },
    });

    // Read back and verify.
    const check = await prisma.formTemplate.findUnique({
      where: { id: tpl.id },
    });
    const checkFields = check?.fields as FormField[];
    const ok =
      checkFields.length === after.length &&
      checkFields.some((f) => f.id === "7_pump_mfg_secondary") &&
      checkFields.some((f) => f.id === "8_pump_model_secondary") &&
      JSON.stringify(
        checkFields.find((f) => f.id === "78_coping_loose_chipped_or_missing")
          ?.options,
      ) ===
        JSON.stringify([
          "Loose",
          "Chipped",
          "Cracked",
          "Missing",
          "N/a",
          "None",
        ]);
    if (!ok) throw new Error("POST-WRITE VERIFY FAILED — restore from backup!");
    console.log(
      `\nAPPLIED + VERIFIED: ${checkFields.length} fields on ${tpl.id}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only run as a script — the transform is also imported by tests/fixtures.
if (process.argv[1]?.includes("apply-cassandra-template-edits")) {
  main().catch((e) => {
    console.error("ABORTED:", e.message ?? e);
    process.exit(1);
  });
}
