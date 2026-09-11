// Read-only by default. Deploy Q109 summary-editor support before using --apply.
// Usage: npx tsx scripts/add-reinspection-summary.ts --target <verified-template-id>
//        npx tsx scripts/add-reinspection-summary.ts --target <id> --apply --backup-dir <private-dir>
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import { appendReinspectionSummary } from "../src/lib/reinspection";
import type { FormField } from "../src/lib/forms";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

async function main() {
  const args = process.argv.slice(2);
  function option(name: string): string | undefined {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    return value && !value.startsWith("--") ? value : undefined;
  }
  const target = option("--target");
  const apply = args.includes("--apply");
  const backupDir = option("--backup-dir");
  if (!target)
    throw new Error("Specify --target with the verified live template ID.");
  if (apply && !backupDir)
    throw new Error("--apply requires a private --backup-dir.");
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured.");

  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT id, name, is_default, fields, updated_at
    FROM form_templates WHERE id = ${target}
  `;
  if (rows.length !== 1)
    throw new Error("The selected template was not found.");
  const before = rows[0];
  const result = appendReinspectionSummary(before.fields as FormField[]);
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "read-only",
        id: before.id,
        name: before.name,
        isDefault: before.is_default,
        changed: result.changed,
        beforeFieldCount: (before.fields as FormField[]).length,
        afterFieldCount: result.fields.length,
        lastField: result.fields.at(-1),
      },
      null,
      2,
    ),
  );
  if (!apply || !result.changed) return;

  // Backup must succeed before the only write. No job rows are changed.
  mkdirSync(backupDir!, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir!, `q109-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(before, null, 2), {
    flag: "wx",
    mode: 0o600,
  });

  // Compare the original JSON, not a JS-rounded timestamp: Postgres keeps
  // microseconds. This refuses to overwrite edits made after the preflight.
  const updated = await sql`
    UPDATE form_templates
    SET fields = ${JSON.stringify(result.fields)}::jsonb, updated_at = now()
    WHERE id = ${target} AND fields = ${JSON.stringify(before.fields)}::jsonb
    RETURNING id, fields
  `;
  if (updated.length !== 1) {
    throw new Error(
      "Template changed during preflight. No update applied; review and retry.",
    );
  }
  if (appendReinspectionSummary(updated[0].fields as FormField[]).changed) {
    throw new Error(
      "Template verification failed after update. Inspect the saved backup.",
    );
  }
  console.log(`Q109 verified. Backup: ${backupPath}`);
}

main().catch((error: unknown) => {
  // Provider errors can contain connection details; do not dump objects/stacks.
  console.error(
    error instanceof Error && !/postgres(?:ql)?:\/\//i.test(error.message)
      ? error.message
      : "Template update failed. Check database access without sharing credentials.",
  );
  process.exitCode = 1;
});
