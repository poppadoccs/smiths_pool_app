// READ-ONLY: dump all form templates to backup folder (pre-edit snapshot)
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { writeFileSync, mkdirSync } from "fs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const adapter = new PrismaNeon({
  connectionString: process.env.DATABASE_URL!,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const templates = await prisma.formTemplate.findMany({
    orderBy: { createdAt: "asc" },
  });

  const summary = templates.map((t) => ({
    id: t.id,
    systemKey: t.systemKey,
    name: t.name,
    isDefault: t.isDefault,
    category: t.category,
    fieldCount: Array.isArray(t.fields) ? (t.fields as unknown[]).length : -1,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
  console.log(JSON.stringify(summary, null, 2));

  const backupDir = "C:/Users/renea/pool-app-backups";
  mkdirSync(backupDir, { recursive: true });
  const stamp = "2026-07-09-pre-cassandra";
  writeFileSync(
    `${backupDir}/db-templates-${stamp}.json`,
    JSON.stringify(templates, null, 2),
  );
  console.log(
    `\nBacked up ${templates.length} template(s) to ${backupDir}/db-templates-${stamp}.json`,
  );

  const jobCount = await prisma.job.count();
  const jobsByTemplate = await prisma.job.groupBy({
    by: ["templateId", "status"],
    _count: true,
  });
  console.log(`\nTotal jobs: ${jobCount}`);
  console.log(JSON.stringify(jobsByTemplate, null, 2));
}

main()
  .catch((e) => {
    console.error("Dump error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
