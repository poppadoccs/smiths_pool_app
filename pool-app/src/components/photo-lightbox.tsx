"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { X } from "lucide-react";
import type { PhotoMetadata } from "@/lib/photos";

export function PhotoLightbox({
  photo,
  onClose,
}: {
  photo: PhotoMetadata | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!photo}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-3xl p-2"
        showCloseButton={false}
      >
        {/* Accessible title (visually hidden) */}
        <DialogTitle className="sr-only">
          {photo?.filename ?? "Photo preview"}
        </DialogTitle>

        {photo && (
          <div className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={onClose}
              className="absolute top-1 right-1 z-10 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-black/60 text-white"
            >
              <X className="size-5" />
              <span className="sr-only">Close</span>
            </button>
            {/* Tap image to close (tablet UX — instinctive tap-to-dismiss) */}
            <img
              src={photo.url}
              alt={photo.filename}
              className="max-h-[80vh] max-w-full cursor-pointer rounded-lg object-contain"
              onClick={onClose}
            />
            <p className="mt-2 text-base text-zinc-500">{photo.filename}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
