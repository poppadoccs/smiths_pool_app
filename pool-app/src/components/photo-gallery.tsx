"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deletePhoto } from "@/lib/actions/photos";
import { PhotoLightbox } from "@/components/photo-lightbox";
import type { PhotoMetadata } from "@/lib/photos";

export function PhotoGallery({
  photos,
  jobId,
  readOnly = false,
}: {
  photos: PhotoMetadata[];
  jobId: string;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoMetadata | null>(
    null
  );
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);

  async function handleDelete(photo: PhotoMetadata) {
    setDeletingUrl(photo.url);
    try {
      await deletePhoto(jobId, photo.url);
      toast.success("Photo deleted");
      router.refresh();
    } catch {
      toast.error("Failed to delete photo");
    } finally {
      setDeletingUrl(null);
    }
  }

  if (photos.length === 0) {
    return (
      <p className="text-base text-zinc-500">
        No photos yet. Take a photo or add from your library.
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo) => (
          <div key={photo.url} className="group relative aspect-square">
            <img
              src={photo.url}
              alt={photo.filename}
              className="size-full cursor-pointer rounded-lg object-cover"
              onClick={() => setSelectedPhoto(photo)}
            />
            {!readOnly && (
              <button
                type="button"
                disabled={deletingUrl === photo.url}
                onClick={() => handleDelete(photo)}
                className="absolute top-1 right-1 flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full bg-black/60 p-1.5 text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
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
        ))}
      </div>
      <PhotoLightbox
        photo={selectedPhoto}
        onClose={() => setSelectedPhoto(null)}
      />
    </>
  );
}
