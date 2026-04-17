"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  savePhotoAssignments,
  type PhotoAssignments,
} from "@/lib/actions/photo-assignments";
import type { PhotoMetadata } from "@/lib/photos";
import type { FormData, FormField, FormTemplate } from "@/lib/forms";

const Q108_ID = "108_additional_photos";
const UNASSIGNED = "UNASSIGNED";

export function PhotoAssignmentsEditor({
  jobId,
  photos,
  template,
  initialFormData,
}: {
  jobId: string;
  photos: PhotoMetadata[];
  template: FormTemplate;
  initialFormData: FormData | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const photoFields = useMemo(
    () =>
      template.fields
        .filter((f): f is FormField => f.type === "photo" && f.id !== Q108_ID)
        .sort((a, b) => a.order - b.order),
    [template.fields],
  );

  // Derive initial per-photo target from formData: if a photo's URL is the
  // current value of a non-Q108 photo field, preselect that field.
  const initialAssignments = useMemo<PhotoAssignments>(() => {
    const fd = initialFormData ?? {};
    const urlToField = new Map<string, string>();
    for (const f of photoFields) {
      const v = fd[f.id];
      if (typeof v === "string" && v.length > 0) urlToField.set(v, f.id);
    }
    const out: PhotoAssignments = {};
    for (const p of photos) out[p.url] = urlToField.get(p.url) ?? UNASSIGNED;
    return out;
  }, [photos, photoFields, initialFormData]);

  const [assignments, setAssignments] =
    useState<PhotoAssignments>(initialAssignments);

  function setOne(url: string, target: string) {
    setAssignments((prev) => ({ ...prev, [url]: target }));
  }

  function handleSave() {
    startTransition(async () => {
      const res = await savePhotoAssignments(jobId, assignments);
      if (!res.success) {
        toast.error(res.error ?? "Failed to save assignments");
        return;
      }
      toast.success("Photo assignments saved");
      router.refresh();
    });
  }

  if (photos.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-zinc-900">
          Assign photos to questions
        </h3>
        <p className="text-sm text-zinc-600">
          Pick the question each photo belongs to. Photos left as
          &ldquo;Unassigned&rdquo; or set to &ldquo;Additional photos&rdquo;
          appear at the end of the PDF under Q108.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((photo) => {
          const current = assignments[photo.url] ?? UNASSIGNED;
          return (
            <div key={photo.url} className="space-y-2">
              <div className="aspect-square overflow-hidden rounded-lg border border-zinc-200">
                <img
                  src={photo.url}
                  alt={photo.filename}
                  className="size-full object-cover"
                />
              </div>
              <select
                aria-label={`Assignment for ${photo.filename}`}
                value={current}
                onChange={(e) => setOne(photo.url, e.target.value)}
                disabled={isPending}
                className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-2 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60"
              >
                <option value={UNASSIGNED}>Unassigned</option>
                {photoFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {truncate(f.label, 40)}
                  </option>
                ))}
                <option value={Q108_ID}>Additional photos (Q108)</option>
              </select>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={handleSave}
          disabled={isPending}
          className="min-h-[44px]"
        >
          {isPending ? "Saving…" : "Save assignments"}
        </Button>
      </div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
