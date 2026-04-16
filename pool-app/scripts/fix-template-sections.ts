/**
 * Fixes corrupted section assignments in the Pool/Spa Inspection template.
 * The AI extraction used numbered question labels as section names (e.g., Q1–Q5
 * were all assigned section "4. Type of Installation:"). This script replaces
 * all section values with clean descriptive names keyed by question order.
 *
 * Usage: npx tsx scripts/fix-template-sections.ts
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "path";
loadEnvConfig(resolve(__dirname, ".."));

import { readFileSync } from "fs";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaNeon } from "@prisma/adapter-neon";

// Section mapping by question order range (inclusive).
// Orders 0–4 (Q1–Q5) get undefined → no section header renders.
const SECTION_RANGES: Array<[number, number, string | undefined]> = [
  [0, 4, undefined], // Q1–Q5: general info — no section heading
  [5, 15, "Pool Pump"],
  [16, 16, "Spa Pump"],
  [17, 25, "Pool Filter"],
  [26, 26, "Spa Filter"],
  [27, 32, "Automation"],
  [33, 43, "Sanitation"],
  [44, 49, "Lighting"],
  [50, 59, "Heating & Solar"],
  [60, 71, "Valves"],
  [72, 75, "Pool Deck"],
  [76, 82, "Coping & Tile"],
  [83, 90, "Skimmer & Drains"],
  [91, 96, "Handrail & Ladder"],
  [97, 102, "Pool & Spa Finish"],
  [103, 107, "Additional"],
];

function sectionForOrder(order: number): string | undefined {
  for (const [min, max, section] of SECTION_RANGES) {
    if (order >= min && order <= max) return section;
  }
  return undefined;
}

async function main() {
  const data = JSON.parse(
    readFileSync(resolve(__dirname, "extraction-output.json"), "utf-8"),
  );
  const sourceFields: Array<Record<string, unknown>> = data.template.fields;

  // Re-apply corrected sections over extraction-output.json field data
  const fixedFields = sourceFields.map((f) => {
    const section = sectionForOrder(f.order as number);
    const { section: _old, ...rest } = f; // drop old section key
    return section !== undefined ? { ...rest, section } : rest;
  });

  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const db = new PrismaClient({ adapter });

  try {
    const templates = await db.formTemplate.findMany({
      where: { name: "Pool/Spa Inspection" },
      select: { id: true, name: true },
    });

    if (templates.length === 0) {
      console.error("No 'Pool/Spa Inspection' template found in DB.");
      process.exit(1);
    }

    for (const t of templates) {
      await db.formTemplate.update({
        where: { id: t.id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { fields: fixedFields as any },
      });
      console.log(`Updated template ${t.id} — "${t.name}"`);
    }

    console.log(`Done. ${templates.length} template(s) updated.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
