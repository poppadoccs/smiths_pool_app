import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { LocalTime } from "@/components/local-time";
import type { Metadata } from "next";
import { PhotoUpload } from "@/components/photo-upload";
import { PhotoGallery } from "@/components/photo-gallery";
import { PhotoAssignmentsEditor } from "@/components/photo-assignments";
import type { PhotoMetadata } from "@/lib/photos";
import { JobForm } from "@/components/job-form";
import { SubmitSection } from "@/components/submit-section";
import { EditableCopyButton } from "@/components/editable-copy-button";
import { isEditableCopy } from "@/lib/multi-photo";
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

  // Editable-copy awareness. A copy's photo blobs are SHARED with the
  // SUBMITTED source it was spawned from. deletePhoto calls del() on the
  // underlying blob URL, so allowing delete on the copy would corrupt the
  // source's photo references. This guard is UI-level only for this
  // slice — a future resend/blob-ownership slice replaces it with true
  // per-job blob ownership. Non-destructive editing (assignments, form
  // fields, new uploads) stays enabled.
  const isCopy = isEditableCopy(job.formData as Record<string, unknown> | null);
  const photosReadOnly = isSubmitted || isCopy;

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
            {isCopy && !isSubmitted && (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Photo delete is disabled on editable copies. These photos are
                shared with the original submitted job — deleting one here would
                remove it there too. You can still upload new photos and change
                photo assignments.
              </p>
            )}
            <PhotoGallery
              photos={job.photos as PhotoMetadata[]}
              jobId={job.id}
              readOnly={photosReadOnly}
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

        {job.status === "SUBMITTED" && (
          <Card>
            <CardContent className="space-y-3 p-4">
              {job.lastEmailFailed === true && (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-center">
                  <AlertTriangle className="size-8 text-amber-600" />
                  <h3 className="text-base font-semibold text-amber-800">
                    Email didn&apos;t send
                  </h3>
                  <p className="text-sm text-amber-700">
                    The job is saved on our server, but the office hasn&apos;t
                    received the email. Use <strong>Resend or edit</strong>{" "}
                    below to try again, and let the office know directly so
                    they&apos;re aware.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-zinc-900">
                  Resend or edit
                </h2>
                <p className="text-sm text-zinc-600">
                  Need to resend this submission or fix something? Create a
                  draft copy — the original stays submitted and unchanged.
                  Submitting the copy re-sends the email with an updated PDF and
                  editable link.
                </p>
              </div>
              <EditableCopyButton jobId={job.id} />
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
