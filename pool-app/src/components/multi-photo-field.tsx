"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, ImagePlus, Loader2 } from "lucide-react";
import imageCompression from "browser-image-compression";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  assignAdditionalPhotos,
  assignMultiFieldPhotos,
} from "@/lib/actions/photo-assignments";
import { savePhotoMetadata } from "@/lib/actions/photos";
import {
  ADDITIONAL_PHOTOS_CAP,
  ADDITIONAL_PHOTOS_FIELD_ID,
  getMultiPhotoCap,
  MULTI_PHOTO_FIELD_IDS,
  readFieldPhotoUrls,
} from "@/lib/multi-photo";
import { COMPRESSION_OPTIONS, isHeicFile } from "@/lib/photos";
import type { FormData as JobFormData, FormField } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";

// In-form photo manager for map-backed owner fields:
//   - multi-photo numbered questions (Q5/Q16/Q25/Q40/Q71)
//   - Q108 "Additional Photos"
// Single companion component intentionally: the UX contract is identical
// (thumbnails + per-photo remove + add-from-gallery + capture-new), only
// the server action and the cap source differ. Gallery-pick and capture
// BOTH route through the same writeUrls helper so one-photo-one-owner,
// cap enforcement, and legacy-mirror consistency are all server-authoritative.
//
// Not used for true single-slot photo fields (e.g. pool_hero_photo) — those
// stay on the original single-slot PhotoFieldInput in job-form.tsx.
export function MultiPhotoField({
  jobId,
  field,
  jobPhotos,
  formData,
  disabled = false,
}: {
  jobId: string;
  field: FormField;
  jobPhotos: PhotoMetadata[];
  formData: JobFormData | null;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // Synchronous in-flight lock. `isPending`/`isUploading` are render-closure
  // state — a second handler firing in the same tick reads the SAME stale
  // `false` value the first one saw and the React-state guard does not block
  // it. A ref mutates synchronously, so the second handler sees `true` the
  // moment the first one claims it. Released in the transition's `finally`.
  const lockRef = useRef(false);

  const fieldId = field.id;
  const isQ108 = fieldId === ADDITIONAL_PHOTOS_FIELD_ID;
  const isMultiPhoto = MULTI_PHOTO_FIELD_IDS.has(fieldId);

  // Defensive: never render for a field this component doesn't own.
  if (!isQ108 && !isMultiPhoto) return null;

  const cap = isQ108 ? ADDITIONAL_PHOTOS_CAP : (getMultiPhotoCap(fieldId) ?? 0);

  const currentUrls = readFieldPhotoUrls(formData, fieldId);
  const currentUrlSet = new Set(currentUrls);
  const atCap = currentUrls.length >= cap;

  // Lock contract:
  //   - Entry handlers (addPhoto, removePhoto, handleCapture) check the lock,
  //     run their bail-fast checks, then claim the lock synchronously before
  //     any await or state-scheduling call.
  //   - writeUrls is the single transition starter and the single lock release
  //     point for the gallery/remove paths (released in finally).
  //   - handleCapture also releases on the upload-failure path before throwing
  //     control out; on the success path it hands off to writeUrls which
  //     releases when the assignment transition resolves.
  function writeUrls(newUrls: string[]) {
    startTransition(async () => {
      try {
        const res = isQ108
          ? await assignAdditionalPhotos(jobId, newUrls)
          : await assignMultiFieldPhotos(jobId, fieldId, newUrls);
        if (!res.success) {
          toast.error(res.error ?? "Failed to update photos");
          return;
        }
        router.refresh();
      } finally {
        lockRef.current = false;
      }
    });
  }

  function removePhoto(url: string) {
    if (lockRef.current) return;
    lockRef.current = true;
    writeUrls(currentUrls.filter((u) => u !== url));
  }

  function addPhoto(url: string) {
    if (lockRef.current) return;
    if (currentUrlSet.has(url)) return;
    if (atCap) return;
    lockRef.current = true;
    writeUrls([...currentUrls, url]);
  }

  async function handleCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset immediately so the same file can be reselected after a failure.
    e.target.value = "";
    if (!file) return;
    // Synchronous lock check before any await — a queued second capture
    // event from the same render must not start a parallel upload+assign.
    if (lockRef.current) return;
    if (atCap) {
      toast.error(`At cap for ${field.label} (${cap})`);
      return;
    }
    lockRef.current = true;
    setIsUploading(true);
    try {
      // Mirror the compression + HEIC path from photo-upload.tsx. Kept
      // inline (not factored) to stay within the narrow task scope.
      let processedFile: File = file;
      if (isHeicFile(file)) {
        const heic2any = (await import("heic2any")).default;
        const blob = await heic2any({
          blob: file,
          toType: "image/jpeg",
          quality: 0.8,
        });
        const resultBlob = Array.isArray(blob) ? blob[0] : blob;
        processedFile = new File(
          [resultBlob],
          file.name.replace(/\.(heic|heif)$/i, ".jpg"),
          { type: "image/jpeg" },
        );
      }
      const compressed = await imageCompression(
        processedFile,
        COMPRESSION_OPTIONS,
      );
      const fd = new FormData();
      fd.append("file", compressed);
      fd.append("filename", file.name.replace(/[^a-zA-Z0-9._-]/g, "_"));
      const resp = await fetch("/api/photos/upload", {
        method: "POST",
        body: fd,
      });
      if (!resp.ok) throw new Error("Upload failed");
      const { url } = (await resp.json()) as { url: string };
      // Add to the job photo pool FIRST so the assignment action's
      // ownership check (URL must be in job.photos) passes.
      await savePhotoMetadata(jobId, {
        url,
        filename: file.name,
        size: compressed.size,
      });
      writeUrls([...currentUrls, url]);
    } catch (err) {
      toast.error(
        `Photo upload failed: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
      // Release on the failure path — success path hands the lock off to
      // writeUrls' transition `finally`. Without this, an upload error
      // would leave the lock held until the page reloads.
      lockRef.current = false;
    } finally {
      setIsUploading(false);
    }
  }

  const availableToAdd = jobPhotos.filter((p) => !currentUrlSet.has(p.url));

  return (
    <div className="space-y-2">
      <Label className="text-base">
        {field.label}
        {field.required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>

      <div
        className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50/50 p-2"
        data-testid={`multi-photo-${fieldId}`}
        data-owner-id={fieldId}
      >
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-700">
            Photos{" "}
            <span
              className="ml-1 text-xs text-zinc-500"
              data-testid={`multi-photo-count-${fieldId}`}
            >
              ({currentUrls.length} of {cap})
            </span>
          </span>
          {!disabled && (
            <div className="flex gap-2">
              {/* "Add from gallery" always rendered — showing it only when
                  jobPhotos.length > 0 hid the option during the empty
                  state and forced users to discover it by taking a photo
                  first. Clicking it when no photos are uploaded yet opens
                  the picker with a message that tells them what to do. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsPickerOpen((v) => !v)}
                disabled={isPending || isUploading}
              >
                <ImagePlus className="mr-1 size-3.5" />
                {isPickerOpen ? "Done" : "Add from gallery"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => cameraInputRef.current?.click()}
                disabled={isPending || isUploading || atCap}
                aria-label={`Take photo for ${field.label}`}
              >
                {isUploading ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Camera className="mr-1 size-3.5" />
                )}
                Take photo
              </Button>
            </div>
          )}
        </div>

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif"
          capture="environment"
          className="hidden"
          onChange={handleCapture}
          disabled={disabled || isUploading || atCap}
        />

        {currentUrls.length > 0 && (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {currentUrls.map((url) => {
              const meta = jobPhotos.find((p) => p.url === url);
              return (
                <div key={url} className="relative">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block aspect-square overflow-hidden rounded-md border border-zinc-200"
                    aria-label={`Preview ${meta?.filename ?? "photo"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={meta?.filename ?? "assigned photo"}
                      className="size-full object-cover"
                    />
                  </a>
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`Remove ${meta?.filename ?? "photo"} from ${field.label}`}
                      onClick={() => removePhoto(url)}
                      disabled={isPending}
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

        {isPickerOpen && !disabled && (
          <div className="rounded-md border border-zinc-200 bg-white p-2">
            <p className="mb-1 text-xs text-zinc-600">
              Tap a photo to attach it to {field.label}
              {atCap && ` (at cap — remove one first)`}
            </p>
            {availableToAdd.length === 0 ? (
              <p className="text-xs text-zinc-500">
                {jobPhotos.length === 0
                  ? "No photos uploaded yet — tap Take photo, or upload from the Photos card at the top."
                  : "No available photos — all uploaded photos are already attached here."}
              </p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {availableToAdd.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    aria-label={`Attach ${p.filename} to ${field.label}`}
                    onClick={() => addPhoto(p.url)}
                    disabled={isPending || atCap}
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
    </div>
  );
}
