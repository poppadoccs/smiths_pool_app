/**
 * Forensic truth pass for Kimberly Hennessy's job.
 * Read-only: dumps DB state + simulates the PDF photo resolver to
 * report which photos end up under which buckets.
 */
import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const Q108 = "108_additional_photos";
const TARGETS = ["5", "16", "25", "40", "71"];

type PhotoMeta = { url: string; filename?: string };
type TemplateField = {
  id: string;
  type: string;
  label: string;
  order?: number;
};

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const rows = (await sql`
    SELECT id, name, job_number AS "jobNumber", status,
           created_at AS "createdAt", submitted_at AS "submittedAt",
           photos, form_data AS "formData",
           (SELECT fields FROM form_templates WHERE id = j.template_id) AS fields
    FROM jobs j
    WHERE name ILIKE ${"%Kimberly Hennessy%"}
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    name: string;
    jobNumber: string | null;
    status: string;
    createdAt: Date;
    submittedAt: Date | null;
    photos: unknown;
    formData: unknown;
    fields: unknown;
  }>;

  if (rows.length === 0) {
    console.log("NOT FOUND");
    return;
  }
  const job = rows[0];
  const photos = ((job.photos as PhotoMeta[]) ?? []).filter(Boolean);
  const formData = (job.formData as Record<string, unknown>) ?? {};
  const fields = (job.fields as TemplateField[]) ?? [];

  console.log("====================================================");
  console.log(`Job: ${job.name} (${job.id})`);
  console.log(
    `Status: ${job.status}  Created: ${job.createdAt?.toISOString()}`,
  );
  console.log(
    `Submitted: ${job.submittedAt?.toISOString() ?? "-"}  jobNumber: ${job.jobNumber ?? "-"}`,
  );
  console.log("====================================================\n");

  // --- 1. job.photos ---
  console.log(`--- 1. job.photos (count=${photos.length}) ---`);
  photos.forEach((p, i) => {
    console.log(`  [${i}] filename="${p.filename ?? "-"}"  url=${p.url}`);
  });

  // --- 2. formData values for target questions ---
  console.log(`\n--- 2. formData values for Q5/Q16/Q25/Q40/Q71 ---`);
  // Try both naming conventions: "Q5" / "5" / "5_..." / numeric id prefix
  // Real template uses IDs like "5_pool_area_before", "16_existing_pool", etc.
  const photoFields = fields
    .filter((f) => f.type === "photo")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const targetNum of TARGETS) {
    const match = photoFields.find(
      (f) =>
        f.id === targetNum ||
        f.id.startsWith(`${targetNum}_`) ||
        f.id === `Q${targetNum}` ||
        f.id.startsWith(`q${targetNum}_`),
    );
    if (!match) {
      console.log(`  Q${targetNum}: field NOT FOUND in template`);
      continue;
    }
    const v = formData[match.id];
    const repr =
      v === undefined
        ? "undefined"
        : v === null
          ? "null"
          : typeof v === "string"
            ? v.length === 0
              ? '""'
              : v.length > 100
                ? JSON.stringify(v.slice(0, 100) + "…")
                : JSON.stringify(v)
            : JSON.stringify(v);
    console.log(
      `  Q${targetNum} (${match.id}) [label="${match.label.slice(0, 50)}"]:`,
    );
    console.log(`      value = ${repr}`);
  }

  // --- 3. sentinels ---
  console.log(`\n--- 3. sentinels ---`);
  console.log(
    `  __photoAssignmentsReviewed = ${JSON.stringify(formData["__photoAssignmentsReviewed"])}`,
  );
  const byField = formData["__photoAssignmentsByField"];
  console.log(
    `  __photoAssignmentsByField = ${byField === undefined ? "UNDEFINED (not present)" : JSON.stringify(byField, null, 2)}`,
  );
  const allSentinelKeys = Object.keys(formData).filter((k) =>
    k.startsWith("__"),
  );
  console.log(`  all __-prefixed keys: ${JSON.stringify(allSentinelKeys)}`);

  // --- 4. Simulate the PDF resolver (mirrors generate-pdf.ts) ---
  console.log(`\n--- 4. Simulated PDF render buckets ---`);
  const consumed = new Set<number>();
  const fieldResolvedUrl = new Map<string, string>();

  // Pass 1: explicit URL or filename match
  for (const field of fields) {
    if (field.type !== "photo") continue;
    const raw = formData[field.id];
    if (typeof raw !== "string" || !raw) continue;
    const matchesRaw = raw.startsWith("http")
      ? (p: PhotoMeta) => p.url === raw
      : (p: PhotoMeta) => p.filename === raw;
    const idx = photos.findIndex((p, i) => !consumed.has(i) && matchesRaw(p));
    if (idx >= 0) {
      consumed.add(idx);
      fieldResolvedUrl.set(field.id, photos[idx].url);
    } else if (raw.startsWith("http") && !photos.some((p) => p.url === raw)) {
      fieldResolvedUrl.set(field.id, raw); // external URL pass-through
    }
  }

  // Pass 2 gate
  const reviewed = formData["__photoAssignmentsReviewed"] === true;
  const hasAnyExplicit = fields.some(
    (f) =>
      f.type === "photo" &&
      f.id !== Q108 &&
      typeof formData[f.id] === "string" &&
      (formData[f.id] as string).length > 0,
  );
  console.log(
    `  Pass 2 gate: reviewed=${reviewed} hasAnyExplicit=${hasAnyExplicit}  -> pass2_fires=${!reviewed && !hasAnyExplicit}`,
  );
  if (!reviewed && !hasAnyExplicit) {
    for (const field of fields) {
      if (field.type !== "photo") continue;
      if (field.id === Q108) continue;
      if (fieldResolvedUrl.has(field.id)) continue;
      const idx = photos.findIndex((_, i) => !consumed.has(i));
      if (idx < 0) continue;
      consumed.add(idx);
      fieldResolvedUrl.set(field.id, photos[idx].url);
    }
  }

  // Pass 3: drain remaining to Q108
  const q108Drain = photos.filter((_, i) => !consumed.has(i)).map((p) => p.url);
  const q108Direct = fieldResolvedUrl.get(Q108);
  const q108Urls = [...(q108Direct ? [q108Direct] : []), ...q108Drain];

  // --- 5. Report buckets ---
  for (const targetNum of TARGETS) {
    const match = photoFields.find(
      (f) => f.id === targetNum || f.id.startsWith(`${targetNum}_`),
    );
    if (!match) {
      console.log(`  Q${targetNum}: (no field)`);
      continue;
    }
    const url = fieldResolvedUrl.get(match.id);
    console.log(
      `  Q${targetNum} (${match.id}): count=${url ? 1 : 0}${url ? `  url=${url}` : ""}`,
    );
  }
  console.log(`  Q108: count=${q108Urls.length}`);
  q108Urls.forEach((u, i) => console.log(`      [${i}] ${u}`));

  // --- 6. Set difference ---
  const renderedUrls = new Set<string>();
  for (const u of fieldResolvedUrl.values()) renderedUrls.add(u);
  for (const u of q108Urls) renderedUrls.add(u);
  const storedUrls = new Set(photos.map((p) => p.url));

  const missingFromRender: string[] = [];
  for (const u of storedUrls)
    if (!renderedUrls.has(u)) missingFromRender.push(u);

  const renderedNotStored: string[] = [];
  for (const u of renderedUrls)
    if (!storedUrls.has(u)) renderedNotStored.push(u);

  console.log(`\n--- 6. Set difference ---`);
  console.log(
    `  In job.photos but rendered NOWHERE: count=${missingFromRender.length}`,
  );
  missingFromRender.forEach((u, i) => console.log(`      [${i}] ${u}`));
  console.log(
    `  Rendered in PDF but NOT in job.photos: count=${renderedNotStored.length}`,
  );
  renderedNotStored.forEach((u, i) => console.log(`      [${i}] ${u}`));

  // --- 7. All photo-type fields (for full picture) ---
  console.log(`\n--- 7. All photo-type template fields with stored values ---`);
  for (const f of photoFields) {
    const v = formData[f.id];
    const repr =
      typeof v === "string"
        ? v.length === 0
          ? '""'
          : v.length > 80
            ? v.slice(0, 80) + "…"
            : v
        : JSON.stringify(v);
    const resolved = fieldResolvedUrl.get(f.id);
    console.log(
      `  ${f.id} order=${f.order ?? "-"} | value=${repr} | resolved=${resolved ?? "-"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
