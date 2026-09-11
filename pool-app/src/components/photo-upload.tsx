"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import imageCompression from "browser-image-compression";
import { Button } from "@/components/ui/button";
import { Camera, ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isHeicFile, COMPRESSION_OPTIONS } from "@/lib/photos";
import { useJobSaveHandler, useJobSaves } from "@/components/job-save-provider";

type UploadStatus = {
  id: string;
  fileKey: string;
  filename: string;
  progress: number;
  status: "compressing" | "uploading" | "done" | "error";
  error?: string;
};

export function PhotoUpload({ jobId }: { jobId: string }) {
  const router = useRouter();
  const { isSaving } = useJobSaves();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const processingRef = useRef(false);
  const uploadSequence = useRef(0);
  const pendingUploads = useRef<Promise<void>>(Promise.resolve());
  const failedUploads = useRef(new Map<string, string>());

  const waitForPendingUploads = useCallback(async () => {
    await pendingUploads.current;
    if (failedUploads.current.size > 0) {
      throw new Error(
        "A photo upload failed. Retry it or remove the failed upload before submitting.",
      );
    }
  }, []);
  useJobSaveHandler("photo-uploads", waitForPendingUploads, "prepare");

  const isProcessing = uploads.some(
    (u) => u.status === "compressing" || u.status === "uploading",
  );

  function updateUpload(id: string, patch: Partial<UploadStatus>) {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    );
  }

  async function processFiles(files: File[]) {
    // Process sequentially to avoid iPad memory pressure
    for (const file of files) {
      const id = `${Date.now()}-${uploadSequence.current++}`;
      const originalFilename = file.name;
      const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
      failedUploads.current.delete(fileKey);

      setUploads((prev) => [
        ...prev.filter(
          (upload) => upload.fileKey !== fileKey || upload.status !== "error",
        ),
        {
          id,
          fileKey,
          filename: originalFilename,
          progress: 0,
          status: "compressing",
        },
      ]);

      try {
        // Step 1: HEIC conversion if needed
        let processedFile: File = file;
        if (isHeicFile(file)) {
          console.log("[photo] HEIC detected, converting...");
          const heic2any = (await import("heic2any")).default;
          const blob = await heic2any({
            blob: file,
            toType: "image/jpeg",
            quality: 0.8,
          });
          const resultBlob = Array.isArray(blob) ? blob[0] : blob;
          processedFile = new File(
            [resultBlob],
            originalFilename
              .replace(/\.heic$/i, ".jpg")
              .replace(/\.heif$/i, ".jpg"),
            { type: "image/jpeg" },
          );
          console.log("[photo] HEIC converted");
        }

        // Step 2: Compress
        console.log(
          `[photo] Compressing ${originalFilename} (${(file.size / 1024).toFixed(0)}KB)...`,
        );
        const compressed = await imageCompression(
          processedFile,
          COMPRESSION_OPTIONS,
        );
        console.log(
          `[photo] Compressed to ${(compressed.size / 1024).toFixed(0)}KB, type: ${compressed.type}`,
        );

        // Step 3: Upload to server route (server-side put — no callback needed)
        updateUpload(id, { status: "uploading", progress: 50 });
        console.log("[photo] Starting upload via server route...");

        const formData = new FormData();
        formData.append("file", compressed);
        formData.append("jobId", jobId);
        formData.append("originalFilename", originalFilename);

        const response = await fetch("/api/photos/upload", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || `Upload failed (${response.status})`);
        }

        await response.json();
        updateUpload(id, { progress: 100 });

        // The route responds only after adding its own Blob URL to this job.
        updateUpload(id, { status: "done" });
        setUploads((prev) => prev.filter((u) => u.id !== id));
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        failedUploads.current.set(fileKey, message);
        console.error(`[photo] Error: ${message}`, err);
        updateUpload(id, { status: "error", error: message });
        toast.error(`Failed to upload ${originalFilename}: ${message}`);
      }
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Reset so the same file can be re-selected
    e.target.value = "";
    if (isSaving || processingRef.current || files.length === 0) return;
    processingRef.current = true;
    pendingUploads.current = processFiles(files).finally(() => {
      processingRef.current = false;
    });
  }

  function dismissFailedUpload(upload: UploadStatus) {
    if (isSaving) return;
    failedUploads.current.delete(upload.fileKey);
    setUploads((current) => current.filter((item) => item.id !== upload.id));
  }

  const activeUploads = uploads.filter((u) => u.status !== "done");

  return (
    <div className="space-y-3">
      {/* Hidden file inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/heic,image/heif"
        className="hidden"
        disabled={isSaving || isProcessing}
        onChange={handleChange}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        multiple
        className="hidden"
        disabled={isSaving || isProcessing}
        onChange={handleChange}
      />

      {/* Visible buttons */}
      <div className="flex gap-3">
        <Button
          type="button"
          className="min-h-[56px] flex-1 gap-2 text-lg"
          disabled={isProcessing || isSaving}
          onClick={() => cameraInputRef.current?.click()}
        >
          <Camera className="size-5" />
          Take Photo
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-[56px] flex-1 gap-2 text-lg"
          disabled={isProcessing || isSaving}
          onClick={() => libraryInputRef.current?.click()}
        >
          <ImagePlus className="size-5" />
          From Library
        </Button>
      </div>

      {/* Upload progress */}
      {activeUploads.length > 0 && (
        <div className="space-y-2">
          {activeUploads.map((u) => (
            <div key={u.id} className="space-y-1">
              <p className="truncate text-sm text-zinc-600">{u.filename}</p>
              {u.status === "compressing" && (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="size-4 animate-spin" />
                  Compressing...
                </div>
              )}
              {u.status === "uploading" && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                  <div
                    className="h-full rounded-full bg-zinc-900 transition-all duration-200"
                    style={{ width: `${u.progress}%` }}
                  />
                </div>
              )}
              {u.status === "error" && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-red-600">{u.error}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isSaving}
                    onClick={() => dismissFailedUpload(u)}
                    aria-label={`Remove failed upload ${u.filename}`}
                  >
                    Remove failed upload
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
