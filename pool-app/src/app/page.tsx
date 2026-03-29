import { db } from "@/lib/db";
import Link from "next/link";
import { JobList } from "@/components/job-list";
import { CreateJobForm } from "@/components/create-job-form";
import { Separator } from "@/components/ui/separator";
import { Settings } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const jobs = await db.job.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <h1 className="text-2xl font-bold text-zinc-900">Pool Field Forms</h1>
      <p className="mt-1 text-lg text-zinc-600">
        Select a job or create a new one.
      </p>
      <CreateJobForm />
      <Separator className="my-6" />
      <JobList jobs={jobs} />
      <Separator className="my-6" />
      <Link
        href="/admin"
        className="flex items-center justify-center gap-2 py-3 text-sm text-zinc-400 hover:text-zinc-600"
      >
        <Settings className="size-4" />
        Settings
      </Link>
    </main>
  );
}
