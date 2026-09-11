"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  savePhotoAssignments,
  type PhotoAssignments,
} from "@/lib/actions/photo-assignments";
import type { PhotoMetadata } from "@/lib/photos";
import type { FormData, FormField, FormTemplate } from "@/lib/forms";
import {
  ADDITIONAL_PHOTOS_FIELD_ID,
  MULTI_PHOTO_FIELD_IDS,
} from "@/lib/multi-photo";
import { useJobSaveHandler, useJobSaves } from "@/components/job-save-provider";

const UNASSIGNED = "UNASSIGNED";

// A target is safe to offer in this legacy single-URL editor ONLY if the
// backend's savePhotoAssignments would accept it. That means: template
// photo field, not Q108, and not a multi-photo map-backed owner
// (Q5/Q16/Q25/Q40/Q71). Keeping this predicate local and explicit makes
// the UI/backend contract legible. Remarks-photo synthetic owner ids
// (`*_remarks_notes_photos`) are never template fields, so no extra
// guard is needed for them.
function isLegacySingleSlotPhotoField(f: FormField): boolean {
  if (f.type !== "photo") return false;
  if (f.id === ADDITIONAL_PHOTOS_FIELD_ID) return false;
  if (MULTI_PHOTO_FIELD_IDS.has(f.id)) return false;
  return true;
}

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
  const { isSaving, updateFormFields } = useJobSaves();
  const [isPending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  const photoFields = useMemo(
    () =>
      template.fields
        .filter(isLegacySingleSlotPhotoField)
        .sort((a, b) => a.order - b.order),
    [template.fields],
  );

  // Derive initial per-photo target from formData: if a photo's URL is the
  // current legacy-mirror value of a legacy single-slot photo field,
  // preselect that field. Map-backed owners are intentionally not
  // reflected here — they are managed by their dedicated action and UI.
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
  const assignmentsRef = useRef(initialAssignments);
  const serverAssignments = useRef(initialAssignments);
  const lastSaved = useRef(initialAssignments);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const replaceAssignments = useCallback((next: PhotoAssignments) => {
    assignmentsRef.current = next;
    setAssignments(next);
  }, []);

  useEffect(() => {
    const current = assignmentsRef.current;
    const next = Object.fromEntries(
      Object.entries(initialAssignments).map(([url, target]) => [
        url,
        url in current && current[url] !== serverAssignments.current[url]
          ? current[url]
          : target,
      ]),
    );
    serverAssignments.current = initialAssignments;
    lastSaved.current = initialAssignments;
    if (JSON.stringify(next) !== JSON.stringify(current))
      replaceAssignments(next);
  }, [initialAssignments, replaceAssignments]);

  const flushAssignments = useCallback(() => {
    const pending = saveQueue.current.then(async () => {
      const snapshot = { ...assignmentsRef.current };
      if (JSON.stringify(snapshot) === JSON.stringify(lastSaved.current))
        return;
      try {
        const res = await savePhotoAssignments(jobId, snapshot);
        if (!res.success)
          throw new Error(res.error ?? "Failed to save assignments");
        lastSaved.current = snapshot;
        // This action writes legacy field mirrors too. Synchronize RHF
        // before the coordinator saves normal fields, preserving other edits.
        updateFormFields(
          Object.fromEntries(
            photoFields.map((field) => [
              field.id,
              Object.entries(snapshot).find(
                ([, target]) => target === field.id,
              )?.[0] ?? "",
            ]),
          ),
        );
        setSaveError(null);
        router.refresh();
      } catch (error) {
        setSaveError(
          error instanceof Error ? error.message : "Failed to save assignments",
        );
        throw error;
      }
    });
    saveQueue.current = pending.catch(() => undefined);
    return pending;
  }, [jobId, photoFields, router, updateFormFields]);

  useJobSaveHandler(
    photoFields.length ? "legacy-photo-assignments" : null,
    flushAssignments,
    "prepare",
  );

  function setOne(url: string, target: string) {
    if (isSaving) return;
    replaceAssignments({ ...assignmentsRef.current, [url]: target });
    setSaveError(null);
  }

  function handleSave() {
    if (isSaving) return;
    startTransition(async () => {
      try {
        await flushAssignments();
        toast.success("Photo assignments saved");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to save assignments",
        );
      }
    });
  }

  if (photos.length === 0) return null;
  // When the template has no legacy single-slot photo fields (current state
  // for Pool Install: every photo question is map-backed), this editor has
  // nothing to offer — rendering it just prints "Unassigned"-only dropdowns
  // above every uploaded photo, which reads as a duplicate thumbnail block
  // above the form. Hide it entirely in that case. The per-field companion
  // UI inside the form (MultiPhotoField / RemarksPhotosField / Q108) owns
  // every assignment path that still exists.
  if (photoFields.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-zinc-900">
          Assign photos to questions
        </h3>
        <p className="text-sm text-zinc-600">
          Pick the single-slot question each photo belongs to. Multi-photo
          questions (Q5/Q16/Q25/Q40/Q71), Q108, and remarks sections are managed
          from their own controls in the form below. Photos left as
          &ldquo;Unassigned&rdquo; appear at the end of the PDF under Q108.
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
                disabled={isPending || isSaving}
                className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-2 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60"
              >
                <option value={UNASSIGNED}>Unassigned</option>
                {photoFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {truncate(f.label, 40)}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      {saveError && (
        <div role="alert" className="space-y-1 text-sm text-red-600">
          <p>{saveError}</p>
          <button
            type="button"
            className="min-h-[44px] underline"
            disabled={isPending || isSaving}
            onClick={() => {
              replaceAssignments(lastSaved.current);
              setSaveError(null);
            }}
          >
            Keep saved assignments
          </button>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={handleSave}
          disabled={isPending || isSaving}
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
