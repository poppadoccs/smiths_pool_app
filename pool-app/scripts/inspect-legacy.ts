import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL missing");
const adapter = new PrismaNeon({ connectionString });
const db = new PrismaClient({ adapter });

async function main() {
  const jobs = await db.job.findMany({
    where: { status: { in: ["SUBMITTED", "DRAFT"] } },
    select: {
      id: true,
      name: true,
      jobNumber: true,
      status: true,
      photos: true,
      formData: true,
      template: { select: { fields: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  for (const job of jobs) {
    const photos = (job.photos as { url: string; filename: string }[]) ?? [];
    const formData = (job.formData as Record<string, unknown>) ?? {};
    const fields =
      (job.template?.fields as { id: string; type: string; label: string }[]) ??
      [];
    const photoFields = fields.filter((f) => f.type === "photo");

    console.log("---");
    console.log(`job: ${job.name ?? job.jobNumber ?? job.id} (${job.status})`);
    console.log(`job.id: ${job.id}`);
    console.log(`photos count: ${photos.length}`);
    if (photos[0]) {
      console.log(`  first photo url: ${photos[0].url?.slice(0, 80)}`);
      console.log(`  first photo filename: ${photos[0].filename}`);
    }
    console.log(`formData keys count: ${Object.keys(formData).length}`);
    console.log(`photo fields in template: ${photoFields.length}`);
    for (const pf of photoFields.slice(0, 8)) {
      const raw = formData[pf.id];
      console.log(
        `  ${pf.id} (${pf.label.slice(0, 40)}): ${
          typeof raw === "string"
            ? raw.length > 80
              ? raw.slice(0, 80) + "…"
              : JSON.stringify(raw)
            : JSON.stringify(raw)
        }`,
      );
    }
  }
}

main().finally(() => db.$disconnect());
