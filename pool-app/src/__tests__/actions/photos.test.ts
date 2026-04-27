import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @vercel/blob del()
vi.mock("@vercel/blob", () => ({
  del: vi.fn().mockResolvedValue(undefined),
}));

// Mock Prisma — these actions hit db.$executeRaw directly (atomic SQL
// UPDATEs against the photos jsonb column). Each test sets the resolved
// value: 1 = row affected (happy), 0 = no rows (job not found path).
vi.mock("@/lib/db", () => ({
  db: {
    $executeRaw: vi.fn().mockResolvedValue(1),
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
  vi.mocked(db.$executeRaw).mockResolvedValue(1);
});

describe("savePhotoMetadata", () => {
  it("appends photo to job photos array via raw SQL UPDATE", async () => {
    await savePhotoMetadata("job-1", {
      url: "https://blob.vercel-storage.com/new.jpg",
      filename: "new.jpg",
      size: 800000,
    });

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const call = vi.mocked(db.$executeRaw).mock.calls[0];
    const subs = call.slice(1) as unknown[];
    expect(subs[0]).toContain(
      '"url":"https://blob.vercel-storage.com/new.jpg"',
    );
    expect(subs[0]).toContain('"filename":"new.jpg"');
    expect(subs[0]).toContain('"size":800000');
    expect(subs[1]).toBe("job-1");
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("works for the first photo (SQL handles NULL/empty via COALESCE)", async () => {
    await savePhotoMetadata("job-2", {
      url: "https://blob.vercel-storage.com/first.jpg",
      filename: "first.jpg",
      size: 600000,
    });

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const call = vi.mocked(db.$executeRaw).mock.calls[0];
    const subs = call.slice(1) as unknown[];
    expect(subs[0]).toContain(
      '"url":"https://blob.vercel-storage.com/first.jpg"',
    );
    expect(subs[1]).toBe("job-2");
  });

  it("throws when job not found (zero rows affected)", async () => {
    vi.mocked(db.$executeRaw).mockResolvedValueOnce(0);

    await expect(
      savePhotoMetadata("no-job", { url: "x", filename: "x", size: 0 }),
    ).rejects.toThrow("Job not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deletePhoto", () => {
  it("deletes blob and removes photo from array via raw SQL UPDATE", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
      formData: {},
    } as never);

    await deletePhoto("job-1", "https://blob.vercel-storage.com/delete.jpg");

    expect(del).toHaveBeenCalledWith(
      "https://blob.vercel-storage.com/delete.jpg",
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const call = vi.mocked(db.$executeRaw).mock.calls[0];
    const subs = call.slice(1) as unknown[];
    expect(subs[0]).toBe("https://blob.vercel-storage.com/delete.jpg");
    expect(subs[1]).toBe("job-1");
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("throws when job not found (findUnique returns null)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce(null);

    await expect(
      deletePhoto("no-job", "https://blob.vercel-storage.com/x.jpg"),
    ).rejects.toThrow("Job not found");
    expect(del).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses delete when job is SUBMITTED (server-side guard mirrors UI)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "SUBMITTED",
      formData: {},
    } as never);

    await expect(
      deletePhoto("submitted-1", "https://blob.vercel-storage.com/x.jpg"),
    ).rejects.toThrow("Cannot delete photos from a submitted job");
    // Critical: neither destructive op runs before the guard rejects.
    expect(del).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses delete when job is an editable copy (carries __sourceJobId)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
      formData: { __sourceJobId: "src-original" },
    } as never);

    await expect(
      deletePhoto("copy-1", "https://blob.vercel-storage.com/shared.jpg"),
    ).rejects.toThrow("Cannot delete photos from an editable copy");
    // Critical: del() must NOT run on a shared blob — that would also
    // break the source job's reference to the same URL.
    expect(del).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
