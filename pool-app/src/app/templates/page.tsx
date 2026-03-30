import { db } from "@/lib/db";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Plus, ScanLine, FileText } from "lucide-react";
import type { Metadata } from "next";
import type { FormField } from "@/lib/forms";
import { TemplateCard } from "@/components/template-card";

export const metadata: Metadata = {
  title: "Templates | Pool Field Forms",
};

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const templates = await db.formTemplate.findMany({
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    include: { _count: { select: { jobs: true } } },
  });

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <Link href="/">
        <Button variant="ghost" className="min-h-[48px] gap-2 text-base">
          <ArrowLeft className="size-5" />
          Back to Jobs
        </Button>
      </Link>

      <div className="mt-4 space-y-1">
        <h1 className="text-2xl font-bold text-zinc-900">Form Templates</h1>
        <p className="text-base text-zinc-500">
          Create and manage reusable form templates.
        </p>
      </div>

      {/* Action buttons */}
      <div className="mt-6 flex gap-3">
        <Link href="/templates/new" className="flex-1">
          <Button className="w-full min-h-[52px] text-base gap-2">
            <Plus className="size-5" />
            New Template
          </Button>
        </Link>
        <Link href="/templates/scan" className="flex-1">
          <Button
            variant="outline"
            className="w-full min-h-[52px] text-base gap-2"
          >
            <ScanLine className="size-5" />
            Scan Form
          </Button>
        </Link>
      </div>

      <Separator className="my-6" />

      {/* Template list */}
      {templates.length === 0 ? (
        <div className="py-12 text-center">
          <FileText className="mx-auto size-12 text-zinc-300" />
          <p className="mt-3 text-base text-zinc-500">No templates yet.</p>
          <p className="text-sm text-zinc-400">
            Create one manually or scan a paper form.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((tpl) => (
            <TemplateCard
              key={tpl.id}
              id={tpl.id}
              name={tpl.name}
              description={tpl.description}
              isDefault={tpl.isDefault}
              fieldCount={(tpl.fields as FormField[]).length}
              jobCount={tpl._count.jobs}
            />
          ))}
        </div>
      )}
    </main>
  );
}
