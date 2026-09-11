"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, FileText, FileX } from "lucide-react";
import { toast } from "sonner";
import { deletePhoto, setPhotoIncludedInPdf } from "@/lib/actions/photos";
import { PhotoLightbox } from "@/components/photo-lightbox";
import type { PhotoMetadata } from "@/lib/photos";
import { useJobSaveHandler, useJobSaves } from "@/components/job-save-provider";

// Treat undefined and true identically as "included" — preserves pre-feature
// behavior for legacy photos written before the includedInPdf field existed.
function isIncludedInPdf(photo: PhotoMetadata): boolean {
  return photo.includedInPdf !== false;
}

export function PhotoGallery({
  photos,
  jobId,
  readOnly = false,
  allowPdfInclusionToggle,
}: {
  photos: PhotoMetadata[];
  jobId: string;
  readOnly?: boolean;
  // When omitted, tracks !readOnly (preserves pre-feature behavior). Set
  // explicitly to keep the include/exclude toggle visible while delete stays
  // gated by readOnly — the editable-copy case, where the photo blob is
  // shared with the SUBMITTED source so destructive ops are unsafe but the
  // copy's own PDF makeup is fully editable.
  allowPdfInclusionToggle?: boolean;
}) {
  const showPdfToggle = allowPdfInclusionToggle ?? !readOnly;
  const router = useRouter();
  const { isSaving } = useJobSaves();
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoMetadata | null>(
    null,
  );
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const [togglingUrl, setTogglingUrl] = useState<string | null>(null);
  const pendingOperation = useRef<Promise<void> | null>(null);
  const failedOperations = useRef(new Map<string, string>());
  const [operationErrors, setOperationErrors] = useState<string[]>([]);

  const waitForPhotoChanges = useCallback(async () => {
    await pendingOperation.current;
    if (failedOperations.current.size > 0) {
      throw new Error(
        "A photo change failed. Retry it or dismiss the error before saving.",
      );
    }
  }, []);
  useJobSaveHandler("photo-gallery", waitForPhotoChanges, "prepare");

  function runPhotoChange(
    key: string,
    operation: () => Promise<void>,
    errorMessage: string,
  ) {
    pendingOperation.current = Promise.resolve()
      .then(operation)
      .then(() => {
        failedOperations.current.delete(key);
      })
      .catch(() => {
        failedOperations.current.set(key, errorMessage);
        toast.error(errorMessage);
      })
      .finally(() => {
        setOperationErrors([...failedOperations.current.values()]);
        setDeletingUrl(null);
        setTogglingUrl(null);
        pendingOperation.current = null;
      });
  }

  function handleDelete(photo: PhotoMetadata) {
    if (isSaving || pendingOperation.current) return;
    setDeletingUrl(photo.url);
    runPhotoChange(
      `delete:${photo.url}`,
      async () => {
        const result = await deletePhoto(jobId, photo.url);
        if (result?.blobCleanupPending) {
          toast.warning(
            "Photo removed from the job; stored file cleanup could not finish.",
          );
        } else {
          toast.success("Photo deleted");
        }
        failedOperations.current.delete(`toggle:${photo.url}`);
        router.refresh();
      },
      "Failed to delete photo",
    );
  }

  function handleTogglePdf(photo: PhotoMetadata) {
    if (isSaving || pendingOperation.current) return;
    const next = !isIncludedInPdf(photo);
    setTogglingUrl(photo.url);
    runPhotoChange(
      `toggle:${photo.url}`,
      async () => {
        await setPhotoIncludedInPdf(jobId, photo.url, next);
        toast.success(
          next ? "Photo included in PDF" : "Photo excluded from PDF",
        );
        router.refresh();
      },
      "Failed to update PDF inclusion",
    );
  }

  return (
    <>
      {operationErrors.length > 0 && (
        <div role="alert" className="mb-3 text-sm text-red-600">
          <p>{operationErrors.join(". ")}. Retry the change or dismiss it.</p>
          <button
            type="button"
            disabled={isSaving || !!deletingUrl || !!togglingUrl}
            className="mt-1 min-h-11 underline"
            onClick={() => {
              failedOperations.current.clear();
              setOperationErrors([]);
            }}
          >
            Dismiss failed photo change
          </button>
        </div>
      )}
      {photos.length === 0 && (
        <p className="text-base text-zinc-500">
          No photos yet. Take a photo or add from your library.
        </p>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo) => {
          const included = isIncludedInPdf(photo);
          const toggling = togglingUrl === photo.url;
          return (
            <div
              key={photo.url}
              className="group relative aspect-square"
              data-testid={`photo-tile-${photo.url}`}
              data-included-in-pdf={included ? "true" : "false"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.url}
                alt={photo.filename}
                className={`size-full cursor-pointer rounded-lg object-cover ${
                  included ? "" : "opacity-50"
                }`}
                onClick={() => setSelectedPhoto(photo)}
              />
              {!included && (
                <span
                  className="pointer-events-none absolute bottom-1 left-1 rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                  data-testid={`excluded-badge-${photo.url}`}
                >
                  Not in PDF
                </span>
              )}
              {showPdfToggle && (
                <button
                  type="button"
                  aria-label={
                    included
                      ? `Exclude ${photo.filename} from PDF`
                      : `Include ${photo.filename} in PDF`
                  }
                  disabled={isSaving || !!deletingUrl || !!togglingUrl}
                  onClick={() => handleTogglePdf(photo)}
                  className="absolute top-1 left-1 flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full bg-black/60 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:opacity-60"
                >
                  {toggling ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : included ? (
                    <FileText className="size-4" />
                  ) : (
                    <FileX className="size-4" />
                  )}
                  <span className="sr-only">
                    {included ? "Exclude from PDF" : "Include in PDF"}
                  </span>
                </button>
              )}
              {!readOnly && (
                <button
                  type="button"
                  disabled={isSaving || !!deletingUrl || !!togglingUrl}
                  onClick={() => handleDelete(photo)}
                  className="absolute top-1 right-1 flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full bg-black/60 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                >
                  {deletingUrl === photo.url ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  <span className="sr-only">Delete photo</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <PhotoLightbox
        photo={selectedPhoto}
        onClose={() => setSelectedPhoto(null)}
      />
    </>
  );
}
