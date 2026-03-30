import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { ScanFlow } from "@/components/scan-flow";
import { isMockMode } from "@/lib/actions/scan";

export const metadata: Metadata = {
  title: "Scan Form | Pool Field Forms",
};

export default function ScanFormPage() {
  const mockMode = isMockMode();

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <Link href="/templates">
        <Button variant="ghost" className="min-h-[48px] gap-2 text-base">
          <ArrowLeft className="size-5" />
          Back to Templates
        </Button>
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-zinc-900">
        Scan a Paper Form
      </h1>
      <p className="mt-1 text-base text-zinc-500">
        Take a photo of a blank form and we&apos;ll convert it to a digital
        template.
      </p>

      <div className="mt-6">
        <ScanFlow mockMode={mockMode} />
      </div>
    </main>
  );
}
