import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { TemplateEditor } from "@/components/template-editor";

export const metadata: Metadata = {
  title: "New Template | Pool Field Forms",
};

export default function NewTemplatePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <Link href="/templates">
        <Button variant="ghost" className="min-h-[48px] gap-2 text-base">
          <ArrowLeft className="size-5" />
          Back to Templates
        </Button>
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-zinc-900">
        Create Template
      </h1>
      <p className="mt-1 text-base text-zinc-500">
        Build a reusable form template from scratch.
      </p>

      <div className="mt-6">
        <TemplateEditor mode="create" />
      </div>
    </main>
  );
}
