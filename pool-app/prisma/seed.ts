import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const adapter = new PrismaNeon({
  connectionString: process.env.DATABASE_URL!,
});
const prisma = new PrismaClient({ adapter });

async function main() {
  // Clear existing data for idempotent seeding
  await prisma.job.deleteMany();

  await prisma.job.createMany({
    data: [
      {
        name: "Smith Residence Pool",
        jobNumber: "2024-042",
        status: "DRAFT",
      },
      {
        name: "Johnson Backyard Renovation",
        jobNumber: "2024-043",
        status: "DRAFT",
      },
      {
        name: "Oakwood Community Center",
        jobNumber: "2024-038",
        status: "SUBMITTED",
        submittedBy: "Mike",
        submittedAt: new Date("2024-03-15"),
      },
      {
        name: "Garcia Family Pool",
        status: "DRAFT",
      },
      {
        jobNumber: "2024-041",
        status: "SUBMITTED",
        submittedBy: "Carlos",
        submittedAt: new Date("2024-03-20"),
      },
      {
        name: "Riverside Estates HOA",
        jobNumber: "2024-044",
        status: "DRAFT",
      },
    ],
  });

  console.log("Seeded 6 jobs successfully.");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
