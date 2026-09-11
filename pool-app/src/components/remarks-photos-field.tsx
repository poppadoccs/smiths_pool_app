"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { assignRemarksFieldPhotos } from "@/lib/actions/photo-assignments";
import {
  readFieldPhotoUrls,
  remarksPhotoOwnerIdFor,
  REMARKS_PHOTO_CAP,
} from "@/lib/multi-photo";
import type { FormData as JobFormData } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { useJobSaveHandler, useJobSaves } from "@/components/job-save-provider";

// Companion photo section for a remarks textarea. Reads the current
// assigned URLs from __photoAssignmentsByField via readFieldPhotoUrls,
// routes all writes through assignRemarksFieldPhotos using the synthetic
// `*_remarks_notes_photos` owner id (via remarksPhotoOwnerIdFor). The
// textarea id itself is never treated as a photo owner here — the helper
// is the single transformation surface between textarea id and owner id.
export function RemarksPhotosField({
  jobId,
  textareaFieldId,
  jobPhotos,
  formData,
  disabled = false,
}: {
  jobId: string;
  textareaFieldId: string;
  jobPhotos: PhotoMetadata[];
  formData: JobFormData | null;
  disabled?: boolean;
}) {
  const ownerId = remarksPhotoOwnerIdFor(textareaFieldId);
  const router = useRouter();
  const { isSaving } = useJobSaves();
  const [isPending, startTransition] = useTransition();
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  // Synchronous in-flight lock — see multi-photo-field.tsx for why a ref is
  // required here instead of `isPending`. Two click handlers from the same
  // render share the same `isPending` closure value and both pass a
  // React-state guard. The ref mutates synchronously so the second handler
  // sees the lock the first one just claimed.
  const lockRef = useRef(false);
  const pendingOperation = useRef<Promise<void>>(Promise.resolve());
  const failedOperation = useRef<Error | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const waitForPendingOperation = useCallback(async () => {
    await pendingOperation.current;
    if (failedOperation.current) throw failedOperation.current;
  }, []);
  useJobSaveHandler(
    ownerId ? `remarks-photos:${ownerId}` : null,
    waitForPendingOperation,
    "prepare",
  );

  // Defensive: only remarks textarea ids should render this component.
  // If a non-remarks id somehow reaches here, skip entirely so no random
  // field accidentally grows a photo section.
  if (!ownerId) return null;

  const currentUrls = readFieldPhotoUrls(formData, ownerId);
  const currentUrlSet = new Set(currentUrls);
  const atCap = currentUrls.length >= REMARKS_PHOTO_CAP;

  function writeUrls(newUrls: string[]) {
    failedOperation.current = null;
    setOperationError(null);
    pendingOperation.current = new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          const res = await assignRemarksFieldPhotos(jobId, ownerId!, newUrls);
          if (!res.success) {
            throw new Error(res.error ?? "Failed to update remarks photos");
          }
          router.refresh();
        } catch (error) {
          const failure =
            error instanceof Error
              ? error
              : new Error("Failed to update remarks photos");
          failedOperation.current = failure;
          setOperationError(failure.message);
          toast.error(failure.message);
        } finally {
          lockRef.current = false;
          resolve();
        }
      });
    });
  }

  function removePhoto(url: string) {
    if (lockRef.current || disabled || isSaving) return;
    lockRef.current = true;
    writeUrls(currentUrls.filter((u) => u !== url));
  }

  function addPhoto(url: string) {
    if (lockRef.current || disabled || isSaving) return;
    if (currentUrlSet.has(url)) return;
    if (atCap) return;
    lockRef.current = true;
    writeUrls([...currentUrls, url]);
  }

  const availableToAdd = jobPhotos.filter((p) => !currentUrlSet.has(p.url));

  return (
    <div
      className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50/50 p-2"
      data-testid={`remarks-photos-${textareaFieldId}`}
      data-owner-id={ownerId}
    >
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-700">
          Photos{" "}
          <span
            className="ml-1 text-xs text-zinc-500"
            data-testid={`remarks-photos-count-${textareaFieldId}`}
          >
            ({currentUrls.length} of {REMARKS_PHOTO_CAP})
          </span>
        </span>
        {!disabled && jobPhotos.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsPickerOpen((v) => !v)}
            disabled={isPending || isSaving}
          >
            {isPickerOpen ? "Done" : "Add"}
          </Button>
        )}
      </div>

      {/* Currently-assigned thumbnails with remove buttons */}
      {currentUrls.length > 0 && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {currentUrls.map((url) => {
            const meta = jobPhotos.find((p) => p.url === url);
            return (
              <div key={url} className="relative">
                <div className="aspect-square overflow-hidden rounded-md border border-zinc-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={meta?.filename ?? "remarks photo"}
                    className="size-full object-cover"
                  />
                </div>
                {!disabled && (
                  <button
                    type="button"
                    aria-label={`Remove ${meta?.filename ?? "photo"} from remarks`}
                    onClick={() => removePhoto(url)}
                    disabled={isPending || isSaving}
                    className="absolute top-1 right-1 min-h-[28px] min-w-[28px] rounded-full bg-white/90 px-1 text-sm leading-none font-semibold text-red-600 shadow hover:bg-white disabled:opacity-60"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {operationError && !disabled && (
        <div role="alert" className="space-y-1 text-sm text-red-600">
          <p>{operationError}</p>
          <button
            type="button"
            disabled={isSaving}
            className="min-h-[44px] underline"
            onClick={() => {
              failedOperation.current = null;
              setOperationError(null);
            }}
          >
            Keep current photos
          </button>
        </div>
      )}

      {/* Picker — only when open and not disabled */}
      {isPickerOpen && !disabled && (
        <div className="rounded-md border border-zinc-200 bg-white p-2">
          <p className="mb-1 text-xs text-zinc-600">
            Tap a photo to attach it to this remarks section
            {atCap && " (at cap — remove one first)"}
          </p>
          {availableToAdd.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No available photos — all uploaded photos are already attached
              here.
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {availableToAdd.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  aria-label={`Attach ${p.filename} to this remarks section`}
                  onClick={() => addPhoto(p.url)}
                  disabled={isPending || isSaving || atCap}
                  className="aspect-square overflow-hidden rounded-md border border-zinc-200 hover:opacity-80 disabled:opacity-40"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.filename}
                    className="size-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
