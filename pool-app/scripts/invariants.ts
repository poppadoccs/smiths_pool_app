// Sweeps every job in the database and reports photo-ownership invariant
// violations. Zero writes — pure read + report.
//
// Usage:  npx tsx scripts/invariants.ts
//         npx tsx scripts/invariants.ts --only-violations
//         npx tsx scripts/invariants.ts --json
//
// Exit code:
//   0 — no violations (info findings allowed)
//   1 — one or more violations found

import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { checkJobInvariants, type Finding } from "../src/lib/invariants";
import type { FormData } from "../src/lib/forms";
import type { PhotoMetadata } from "../src/lib/photos";

const sql = neon(process.env.DATABASE_URL!);

const args = new Set(process.argv.slice(2));
const ONLY_VIOLATIONS = args.has("--only-violations");
const JSON_OUT = args.has("--json");

type Row = {
  id: string;
  name: string | null;
  status: string;
  form_data: FormData | null;
  photos: PhotoMetadata[] | null;
};

(async () => {
  const rows = (await sql`
    SELECT id, name, status, form_data, photos
    FROM jobs
    ORDER BY created_at DESC
  `) as Row[];

  type JobReport = {
    id: string;
    name: string | null;
    status: string;
    findings: Finding[];
  };

  const reports: JobReport[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    findings: checkJobInvariants({
      id: r.id,
      name: r.name,
      status: r.status,
      formData: r.form_data,
      photos: r.photos,
    }),
  }));

  const violationCount = reports.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "violation").length,
    0,
  );
  const infoCount = reports.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "info").length,
    0,
  );

  if (JSON_OUT) {
    console.log(
      JSON.stringify({ reports, violationCount, infoCount }, null, 2),
    );
    process.exit(violationCount > 0 ? 1 : 0);
  }

  console.log(`\nScanned ${rows.length} jobs.\n`);
  for (const r of reports) {
    const violations = r.findings.filter((f) => f.severity === "violation");
    const infos = r.findings.filter((f) => f.severity === "info");
    const hasAny = violations.length > 0 || infos.length > 0;
    if (ONLY_VIOLATIONS && violations.length === 0) continue;
    const icon = violations.length > 0 ? "✗" : hasAny ? "!" : "✓";
    const label = r.name ?? "(unnamed)";
    console.log(`${icon} ${label} (${r.id}) [${r.status}]`);
    for (const f of r.findings) {
      const marker = f.severity === "violation" ? "VIOLATION" : "INFO";
      const tail = shortTail(f);
      console.log(`    ${marker} [${f.invariant}] ${f.message}${tail}`);
    }
    if (!hasAny) console.log(`    (clean)`);
  }

  console.log(
    `\nSummary: ${reports.length - violationCount === reports.length ? reports.length : reports.filter((r) => r.findings.every((f) => f.severity !== "violation")).length}/${reports.length} jobs clean, ${violationCount} violation(s), ${infoCount} info finding(s).`,
  );
  process.exit(violationCount > 0 ? 1 : 0);
})();

function shortTail(f: Finding): string {
  const parts: string[] = [];
  if (f.url) parts.push(`url=${f.url.split("/").pop()}`);
  if (f.owner) parts.push(`owner=${f.owner}`);
  if (f.owners && f.owners.length > 0)
    parts.push(`owners=[${f.owners.join(", ")}]`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
