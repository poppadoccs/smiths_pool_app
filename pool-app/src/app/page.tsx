import { db } from "@/lib/db";
import Link from "next/link";
import { JobListFilters } from "@/components/job-list-filters";
import { CreateJobForm } from "@/components/create-job-form";
import { Separator } from "@/components/ui/separator";
import { Settings, FileText } from "lucide-react";
import { ensureDefaultTemplate } from "@/lib/actions/templates";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Seed the default template on first visit (idempotent)
  await ensureDefaultTemplate();

  const [jobs, templates] = await Promise.all([
    db.job.findMany({
      where: { status: { not: "ARCHIVED" } },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    }),
    db.formTemplate.findMany({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <h1 className="text-2xl font-bold text-zinc-900">Pool Field Forms</h1>
      <p className="mt-1 text-lg text-zinc-600">
        Select a job or create a new one.
      </p>
      <CreateJobForm templates={templates} />
      <Separator className="my-6" />
      <JobListFilters jobs={jobs} />
      <Separator className="my-6" />
      <div className="flex items-center justify-center gap-6">
        <Link
          href="/templates"
          className="flex items-center gap-2 py-3 text-sm text-zinc-400 hover:text-zinc-600"
        >
          <FileText className="size-4" />
          Templates
        </Link>
        <Link
          href="/admin"
          className="flex items-center gap-2 py-3 text-sm text-zinc-400 hover:text-zinc-600"
        >
          <Settings className="size-4" />
          Settings
        </Link>
      </div>
    </main>
  );
}
