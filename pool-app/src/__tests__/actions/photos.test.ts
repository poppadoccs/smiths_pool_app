import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @vercel/blob del()
vi.mock("@vercel/blob", () => ({
  del: vi.fn().mockResolvedValue(undefined),
}));

// Mock Prisma -- need findUnique and update on job
vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { savePhotoMetadata, deletePhoto } from "@/lib/actions/photos";
import { db } from "@/lib/db";
import { del } from "@vercel/blob";
import { revalidatePath } from "next/cache";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("savePhotoMetadata", () => {
  it("appends photo to job photos array", async () => {
    (db.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "job-1",
      photos: [
        {
          url: "https://blob.vercel-storage.com/existing.jpg",
          filename: "old.jpg",
          size: 500000,
          uploadedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await savePhotoMetadata("job-1", {
      url: "https://blob.vercel-storage.com/new.jpg",
      filename: "new.jpg",
      size: 800000,
    });

    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        photos: expect.arrayContaining([
          expect.objectContaining({
            url: "https://blob.vercel-storage.com/existing.jpg",
          }),
          expect.objectContaining({
            url: "https://blob.vercel-storage.com/new.jpg",
            filename: "new.jpg",
            size: 800000,
          }),
        ]),
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("works with empty photos array", async () => {
    (db.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "job-2",
      photos: [],
    });

    await savePhotoMetadata("job-2", {
      url: "https://blob.vercel-storage.com/first.jpg",
      filename: "first.jpg",
      size: 600000,
    });

    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-2" },
      data: {
        photos: expect.arrayContaining([
          expect.objectContaining({
            url: "https://blob.vercel-storage.com/first.jpg",
          }),
        ]),
      },
    });
  });

  it("throws when job not found", async () => {
    (db.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      savePhotoMetadata("no-job", { url: "x", filename: "x", size: 0 })
    ).rejects.toThrow("Job not found");
    expect(db.job.update).not.toHaveBeenCalled();
  });
});

describe("deletePhoto", () => {
  it("deletes blob and removes photo from array", async () => {
    (db.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "job-1",
      photos: [
        {
          url: "https://blob.vercel-storage.com/keep.jpg",
          filename: "keep.jpg",
          size: 500000,
          uploadedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          url: "https://blob.vercel-storage.com/delete.jpg",
          filename: "delete.jpg",
          size: 700000,
          uploadedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    await deletePhoto("job-1", "https://blob.vercel-storage.com/delete.jpg");

    expect(del).toHaveBeenCalledWith(
      "https://blob.vercel-storage.com/delete.jpg"
    );
    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        photos: [
          expect.objectContaining({
            url: "https://blob.vercel-storage.com/keep.jpg",
          }),
        ],
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("throws when job not found", async () => {
    (db.job.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      deletePhoto("no-job", "https://blob.vercel-storage.com/x.jpg")
    ).rejects.toThrow("Job not found");
  });
});
