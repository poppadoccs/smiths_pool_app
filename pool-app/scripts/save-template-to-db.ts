/**
 * Seeds / re-seeds the extracted pool-inspection FormTemplate (108 fields,
 * including the 8 `*_remarks_notes` textarea fields, the Q5/Q16/Q25/Q40/Q71
 * multi-photo fields, and Q108 "Additional Photos"). Idempotent — upserts on
 * a stable `systemKey` so running this script N times produces exactly one
 * template row. Self-verifies by reading the saved row back and asserting the
 * 8 remarks textarea ids + Q5 + Q108 are present.
 *
 * Usage:
 *   cd pool-app
 *   npx tsx scripts/save-template-to-db.ts
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "path";
loadEnvConfig(resolve(__dirname, ".."));

import { readFileSync } from "fs";
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

type SeededField = {
  id: string;
  type: string;
  [key: string]: unknown;
};

async function main() {
  const data = JSON.parse(
    readFileSync(resolve(__dirname, "extraction-output.json"), "utf-8"),
  );
  const t = data.template;

  if (!t || !t.fields?.length) {
    console.error("No template data in extraction-output.json");
    process.exit(1);
  }

  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const db = new PrismaClient({ adapter });

  try {
    const row = await db.formTemplate.upsert({
      where: { systemKey: SYSTEM_KEY },
      update: {
        name: t.name || "Pool/Spa Inspection",
        description:
          "Pool & Spa inspection form — 108 questions, extracted from PDF",
        category: "Inspection",
        fields: t.fields,
      },
      create: {
        systemKey: SYSTEM_KEY,
        name: t.name || "Pool/Spa Inspection",
        description:
          "Pool & Spa inspection form — 108 questions, extracted from PDF",
        category: "Inspection",
        fields: t.fields,
      },
    });

    // Self-verify: read back and count the fields that matter for the
    // remarks-photos manual smoke. The assert fails the script if the
    // template does not contain every expected remarks textarea id plus
    // the Q5 + Q108 control fields.
    const saved = await db.formTemplate.findUnique({
      where: { id: row.id },
      select: { id: true, name: true, systemKey: true, fields: true },
    });
    const savedFields = (saved?.fields ?? []) as SeededField[];
    const idToType = new Map(savedFields.map((f) => [f.id, f.type]));

    const presentRemarks = EXPECTED_REMARKS_IDS.filter(
      (id) => idToType.get(id) === "textarea",
    );
    const missingRemarks = EXPECTED_REMARKS_IDS.filter(
      (id) => idToType.get(id) !== "textarea",
    );
    const hasQ5 = idToType.get(Q5_ID) === "photo";
    const hasQ108 = idToType.get(Q108_ID) === "photo";

    console.log(`Template id:    ${saved?.id}`);
    console.log(`Template name:  "${saved?.name}"`);
    console.log(`System key:     ${saved?.systemKey}`);
    console.log(`Total fields:   ${savedFields.length}`);
    console.log(
      `Remarks (textarea) fields present: ${presentRemarks.length} / ${EXPECTED_REMARKS_IDS.length}`,
    );
    if (missingRemarks.length > 0) {
      console.log(`  missing: ${missingRemarks.join(", ")}`);
    } else {
      console.log(`  ids: ${presentRemarks.join(", ")}`);
    }
    console.log(`Q5 multi-photo field present (type=photo):  ${hasQ5}`);
    console.log(`Q108 additional-photos present (type=photo): ${hasQ108}`);

    if (missingRemarks.length > 0 || !hasQ5 || !hasQ108) {
      console.error(
        `\nFAIL: seeded template is missing required fields for the remarks-photos smoke.`,
      );
      process.exit(2);
    }

    console.log(
      `\nOK: template seeded and verified for the remarks-photos smoke.`,
    );
    console.log(
      `Next: start the dev server and pick "${saved?.name}" in the New Job form.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
