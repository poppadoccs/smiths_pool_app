import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { TemplateEditor } from "@/components/template-editor";
import type { Metadata } from "next";
import type { FormField } from "@/lib/forms";

type Props = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tpl = await db.formTemplate.findUnique({ where: { id } });
  if (!tpl) return { title: "Template Not Found" };
  return { title: `Edit: ${tpl.name} | Pool Field Forms` };
}

export default async function EditTemplatePage({ params }: Props) {
  const { id } = await params;
  const tpl = await db.formTemplate.findUnique({ where: { id } });

  if (!tpl) {
    notFound();
  }

  const fields = tpl.fields as FormField[];

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <Link href="/templates">
        <Button variant="ghost" className="min-h-[48px] gap-2 text-base">
          <ArrowLeft className="size-5" />
          Back to Templates
        </Button>
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-zinc-900">
        Edit Template
      </h1>
      <p className="mt-1 text-base text-zinc-500">
        Modify fields, labels, types, and ordering.
      </p>

      <div className="mt-6">
        <TemplateEditor
          mode="edit"
          templateId={tpl.id}
          initialName={tpl.name}
          initialDescription={tpl.description || ""}
          initialCategory={tpl.category || ""}
          initialFields={fields}
        />
      </div>
    </main>
  );
}
