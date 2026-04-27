import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const sql = neon(process.env.DATABASE_URL!);

const JOB_ID = "cmo7fmc2f0000zos6sdoplsha";

(async () => {
  const rows = (await sql`
    SELECT id, name, status, form_data, photos
    FROM jobs WHERE id = ${JOB_ID}
  `) as Array<{
    id: string;
    name: string | null;
    status: string;
    form_data: Record<string, unknown> | null;
    photos: Array<{ url: string; filename: string }> | null;
  }>;
  if (rows.length === 0) {
    console.log("NO JOB");
    process.exit(1);
  }
  const job = rows[0];
  const fd = job.form_data ?? {};
  const map =
    (fd["__photoAssignmentsByField"] as Record<string, unknown>) ?? {};
  const photos = job.photos ?? [];

  console.log("JOB:", job.id, "| status:", job.status);
  console.log("photos.count:", photos.length);

  console.log("\n=== MAP BUCKETS ===");
  for (const [owner, urls] of Object.entries(map)) {
    const list = Array.isArray(urls) ? urls : [];
    console.log(`  ${owner}: [${list.length}]`);
    for (const u of list) console.log(`    - ${String(u).split("/").pop()}`);
  }

  console.log("\n=== LEGACY MIRRORS (non-empty http strings) ===");
  for (const [k, v] of Object.entries(fd)) {
    if (k.startsWith("__")) continue;
    if (typeof v !== "string") continue;
    if (!v.startsWith("http")) continue;
    console.log(`  ${k}: ${v.split("/").pop()}`);
  }

  console.log("\n=== CROSS-OWNER DUPLICATE CHECK ===");
  const urlToOwners: Record<string, string[]> = {};
  for (const [owner, urls] of Object.entries(map)) {
    const list = Array.isArray(urls) ? urls : [];
    for (const u of list) {
      if (typeof u !== "string") continue;
      (urlToOwners[u] ||= []).push(`map:${owner}`);
    }
  }
  for (const [k, v] of Object.entries(fd)) {
    if (k.startsWith("__")) continue;
    if (typeof v !== "string") continue;
    if (!v.startsWith("http")) continue;
    (urlToOwners[v] ||= []).push(`mirror:${k}`);
  }
  let dupeCount = 0;
  for (const [u, owners] of Object.entries(urlToOwners)) {
    const uniq = [...new Set(owners)];
    const mapOwners = uniq
      .filter((o) => o.startsWith("map:"))
      .map((o) => o.slice(4));
    const mirrorFields = uniq
      .filter((o) => o.startsWith("mirror:"))
      .map((o) => o.slice(7));
    const distinctFields = new Set([...mapOwners, ...mirrorFields]);
    if (distinctFields.size > 1) {
      dupeCount++;
      console.log(
        `  DUPE: ${u.split("/").pop()} -> ${[...distinctFields].join(", ")}`,
      );
    }
  }
  if (dupeCount === 0) console.log("  (none)");

  console.log("\n=== photos[] urls ===");
  for (const p of photos) console.log(`  - ${p.url.split("/").pop()}`);

  process.exit(0);
})();
