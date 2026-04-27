/**
 * Read-only verification for the remarks-capable seeded template.
 * Asserts exactly one FormTemplate row exists with the remarks-photos
 * smoke systemKey, and reports its id + required-field presence.
 *
 * Usage:
 *   cd pool-app
 *   npx tsx scripts/verify-remarks-template.ts
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "path";
loadEnvConfig(resolve(__dirname, ".."));

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaNeon } from "@prisma/adapter-neon";

const SYSTEM_KEY = "extracted_pool_inspection_v1";

const EXPECTED_REMARKS_IDS = [
  "15_remarks_notes",
  "33_remarks_notes",
  "72_remarks_notes",
  "76_remarks_notes",
  "79_remarks_notes",
  "83_remarks_notes",
  "91_remarks_notes",
  "102_remarks_notes",
];
const Q5_ID = "5_picture_of_pool_and_spa_if_applicable";
const Q108_ID = "108_additional_photos";

type SeededField = { id: string; type: string; [key: string]: unknown };

async function main() {
  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const db = new PrismaClient({ adapter });

  try {
    const rows = await db.formTemplate.findMany({
      where: { systemKey: SYSTEM_KEY },
      select: { id: true, name: true, systemKey: true, fields: true },
    });

    console.log(
      `FormTemplate rows with systemKey="${SYSTEM_KEY}": ${rows.length}`,
    );
    if (rows.length !== 1) {
      console.error(
        `\nFAIL: expected exactly 1 row, found ${rows.length} (idempotency broken).`,
      );
      process.exit(2);
    }

    const row = rows[0];
    const savedFields = (row.fields ?? []) as SeededField[];
    const idToType = new Map(savedFields.map((f) => [f.id, f.type]));
    const missingRemarks = EXPECTED_REMARKS_IDS.filter(
      (id) => idToType.get(id) !== "textarea",
    );
    const hasQ5 = idToType.get(Q5_ID) === "photo";
    const hasQ108 = idToType.get(Q108_ID) === "photo";

    console.log(`Template id:   ${row.id}`);
    console.log(`Template name: "${row.name}"`);
    console.log(`Total fields:  ${savedFields.length}`);
    console.log(
      `Remarks fields: ${EXPECTED_REMARKS_IDS.length - missingRemarks.length} / ${EXPECTED_REMARKS_IDS.length}`,
    );
    console.log(`Q5 multi-photo (type=photo): ${hasQ5}`);
    console.log(`Q108 additional-photos (type=photo): ${hasQ108}`);

    if (missingRemarks.length > 0 || !hasQ5 || !hasQ108) {
      console.error(`\nFAIL: required smoke fields missing.`);
      if (missingRemarks.length) {
        console.error(`  missing remarks: ${missingRemarks.join(", ")}`);
      }
      process.exit(2);
    }

    console.log(
      `\nOK: remarks-capable template is ready for the manual smoke.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
