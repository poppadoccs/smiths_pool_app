import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const names = ["Doug Domeier", "Kimberly Hennessy", "Judy Thompson"];
  for (const n of names) {
    const rows = await sql`
      SELECT id, name, "jobNumber", status, "createdAt", "submittedAt",
             photos, "formData",
             (SELECT fields FROM "FormTemplate" WHERE id = j."templateId") AS fields
      FROM "Job" j
      WHERE name ILIKE ${"%" + n + "%"}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    if (rows.length === 0) {
      console.log(`\n### ${n}: NOT FOUND`);
      continue;
    }
    const job = rows[0] as {
      id: string;
      name: string;
      jobNumber: string | null;
      status: string;
      createdAt: Date;
      submittedAt: Date | null;
      photos: unknown;
      formData: unknown;
      fields: unknown;
    };
    const photos = (job.photos as Record<string, unknown>[]) ?? [];
    const formData = (job.formData as Record<string, unknown>) ?? {};
    const fields =
      (job.fields as {
        id: string;
        type: string;
        label: string;
        order?: number;
      }[]) ?? [];
    const photoFields = fields.filter((f) => f.type === "photo");

    console.log(`\n### ${job.name} (${job.id}) status=${job.status}`);
    console.log(
      `    created=${job.createdAt?.toISOString()} submitted=${job.submittedAt?.toISOString() ?? "-"}`,
    );
    console.log(
      `    photos=${photos.length} photoFields=${photoFields.length}`,
    );

    console.log(`  Photos in stored order:`);
    photos.forEach((p, i) => {
      const keys = Object.keys(p).sort();
      const vals = keys.map((k) => {
        const v = p[k];
        if (typeof v === "string" && v.length > 60)
          return `${k}=${v.slice(0, 60)}…`;
        return `${k}=${JSON.stringify(v)}`;
      });
      console.log(`    [${i}] ${vals.join(" ")}`);
    });

    console.log(`  Photo-type template fields (by order):`);
    photoFields
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .forEach((f) => {
        const raw = formData[f.id];
        const repr =
          raw === undefined
            ? "undefined"
            : raw === null
              ? "null"
              : typeof raw === "string"
                ? raw.length === 0
                  ? '""'
                  : raw.length > 80
                    ? JSON.stringify(raw.slice(0, 80) + "…")
                    : JSON.stringify(raw)
                : JSON.stringify(raw);
        console.log(
          `    ${f.id} order=${f.order ?? "-"} label="${f.label.slice(0, 50)}" value=${repr}`,
        );
      });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
