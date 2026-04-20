import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";
import { LocalTime } from "@/components/local-time";
import type { Metadata } from "next";
import { PhotoUpload } from "@/components/photo-upload";
import { PhotoGallery } from "@/components/photo-gallery";
import { PhotoAssignmentsEditor } from "@/components/photo-assignments";
import type { PhotoMetadata } from "@/lib/photos";
import { JobForm } from "@/components/job-form";
import { SubmitSection } from "@/components/submit-section";
import {
  DEFAULT_TEMPLATE,
  type FormData,
  type FormField,
  type FormTemplate,
} from "@/lib/forms";

type Props = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const job = await db.job.findUnique({ where: { id } });

  if (!job) {
    return { title: "Job Not Found" };
  }

  return {
    title: `${job.name || "Job #" + job.jobNumber} | Pool Field Forms`,
  };
}

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const job = await db.job.findUnique({
    where: { id },
    include: { template: true },
  });

  if (!job) {
    notFound();
  }

  const isSubmitted = job.status === "SUBMITTED" || job.status === "ARCHIVED";

  // Use the linked template from DB, or fall back to DEFAULT_TEMPLATE
  const template: FormTemplate = job.template
    ? {
        id: job.template.id,
        name: job.template.name,
        version: 1,
        fields: (job.template.fields as FormField[]).sort(
          (a, b) => a.order - b.order,
        ),
      }
    : DEFAULT_TEMPLATE;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-24">
      <Link href="/">
        <Button variant="ghost" className="min-h-[48px] gap-2 text-base">
          <ArrowLeft className="size-5" />
          Back to Jobs
        </Button>
      </Link>

      <div className="mt-4 space-y-2">
        <h1 className="text-2xl font-bold text-zinc-900">
          {job.name || `Job #${job.jobNumber}`}
        </h1>
        {job.name && job.jobNumber && (
          <p className="text-lg text-zinc-600">#{job.jobNumber}</p>
        )}
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
        </div>
        <p className="text-base text-zinc-500">
          Created <LocalTime date={job.createdAt} />
        </p>
        {job.submittedBy && (
          <p className="text-base text-zinc-600">
            Submitted by: {job.submittedBy}
          </p>
        )}
      </div>

      <Separator className="my-6" />

      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-4 p-4">
            <h2 className="text-lg font-semibold text-zinc-900">Photos</h2>
            <PhotoGallery
              photos={job.photos as PhotoMetadata[]}
              jobId={job.id}
              readOnly={isSubmitted}
            />
            {!isSubmitted && (
              <>
                <Separator />
                <PhotoUpload jobId={job.id} />
              </>
            )}
            {!isSubmitted && (job.photos as PhotoMetadata[]).length > 0 && (
              <>
                <Separator />
                <PhotoAssignmentsEditor
                  jobId={job.id}
                  photos={job.photos as PhotoMetadata[]}
                  template={template}
                  initialFormData={(job.formData as FormData) ?? null}
                />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-4">
            <h2 className="text-lg font-semibold text-zinc-900">Form</h2>
            <JobForm
              jobId={job.id}
              template={template}
              initialData={(job.formData as FormData) ?? null}
              jobPhotos={job.photos as PhotoMetadata[]}
              disabled={isSubmitted}
            />
          </CardContent>
        </Card>

        {!isSubmitted && (
          <Card>
            <CardContent className="p-4">
              <SubmitSection jobId={job.id} />
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
