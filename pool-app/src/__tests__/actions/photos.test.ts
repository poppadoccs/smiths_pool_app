import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { transaction, runTransaction } = vi.hoisted(() => {
  const transaction = {
    $queryRaw: vi.fn(),
    job: { updateMany: vi.fn() },
  };
  return {
    transaction,
    runTransaction: vi.fn(
      async (action: (tx: typeof transaction) => Promise<unknown>) =>
        action(transaction),
    ),
  };
});

// Mock @vercel/blob del()
vi.mock("@vercel/blob", () => ({
  del: vi.fn().mockResolvedValue(undefined),
}));

// Toggling uses an atomic SQL UPDATE. Deletion locks and updates inside
// a short transaction; Blob cleanup must happen only after that commits.
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: runTransaction,
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

import { deletePhoto, setPhotoIncludedInPdf } from "@/lib/actions/photos";
import { db } from "@/lib/db";
import { del } from "@vercel/blob";
import { revalidatePath } from "next/cache";
import type { PhotoMetadata } from "@/lib/photos";

const DELETE_URL = "https://blob.vercel-storage.com/delete.jpg";
const KEEP_URL = "https://blob.vercel-storage.com/keep.jpg";
const Q5 = "5_picture_of_pool_and_spa_if_applicable";
const Q109_KEY = "__reinspection_summary_items";

function makeDeletionJob() {
  return {
    status: "DRAFT",
    photos: [DELETE_URL, KEEP_URL].map(
      (url, i): PhotoMetadata => ({
        url,
        filename: `${i}.jpg`,
        size: 100,
        uploadedAt: "2026-09-11T00:00:00.000Z",
        includedInPdf: true,
      }),
    ),
    formData: {
      customer: "Keep this text",
      [Q5]: DELETE_URL,
      __photoAssignmentsByField: { [Q5]: [DELETE_URL, KEEP_URL] },
      __summary_items: [{ text: "Original findings", photos: [DELETE_URL] }],
      [Q109_KEY]: [{ text: "Old reinspection findings", photos: [DELETE_URL] }],
    } as Record<string, unknown> | null,
    templateFields: [{ id: Q5, type: "photo" }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.$executeRaw).mockReset().mockResolvedValue(1);
  vi.mocked(db.job.findUnique).mockReset();
  vi.mocked(del).mockReset().mockResolvedValue(undefined);
  transaction.$queryRaw.mockReset().mockResolvedValue([makeDeletionJob()]);
  transaction.job.updateMany.mockReset().mockResolvedValue({ count: 1 });
  runTransaction.mockImplementation(async (action) => action(transaction));
});

afterEach(() => vi.restoreAllMocks());

describe("deletePhoto", () => {
  it("commits metadata and every reference together before deleting the blob", async () => {
    let committed = false;
    runTransaction.mockImplementation(async (action) => {
      const result = await action(transaction);
      committed = true;
      return result;
    });
    vi.mocked(del).mockImplementation(async () => {
      expect(committed).toBe(true);
    });

    expect(await deletePhoto("job-1", DELETE_URL)).toEqual({
      success: true,
      blobCleanupPending: false,
    });

    const lockCall = transaction.$queryRaw.mock.calls[0];
    expect((lockCall[0] as string[]).join("?")).toContain("FOR UPDATE OF j");
    expect(lockCall[1]).toBe("job-1");
    expect(transaction.job.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "job-1", status: "DRAFT" },
      data: {
        photos: [makeDeletionJob().photos[1]],
        formData: {
          customer: "Keep this text",
          [Q5]: "",
          __photoAssignmentsByField: { [Q5]: [KEEP_URL] },
          __summary_items: [{ text: "Original findings", photos: [] }],
          [Q109_KEY]: [{ text: "Old reinspection findings", photos: [] }],
        },
      },
    });
    expect(del).toHaveBeenCalledExactlyOnceWith(DELETE_URL);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("refuses an unknown job before touching Blob storage", async () => {
    transaction.$queryRaw.mockResolvedValueOnce([]);

    await expect(deletePhoto("no-job", DELETE_URL)).rejects.toThrow(
      "Job not found",
    );
    expect(del).not.toHaveBeenCalled();
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTED", "ARCHIVED"])(
    "refuses deleting from a %s job",
    async (status) => {
      transaction.$queryRaw.mockResolvedValueOnce([
        { ...makeDeletionJob(), status },
      ]);

      await expect(deletePhoto("job-1", DELETE_URL)).rejects.toThrow(
        `Cannot delete photos from a ${status.toLowerCase()} job`,
      );
      expect(del).not.toHaveBeenCalled();
      expect(transaction.job.updateMany).not.toHaveBeenCalled();
    },
  );

  it("refuses delete when job is an editable copy (carries __sourceJobId)", async () => {
    transaction.$queryRaw.mockResolvedValueOnce([
      {
        ...makeDeletionJob(),
        formData: { __sourceJobId: "src-original" },
      },
    ]);

    await expect(deletePhoto("copy-1", DELETE_URL)).rejects.toThrow(
      "Cannot delete photos from an editable copy",
    );
    expect(del).not.toHaveBeenCalled();
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a different job's URL even when the selected job is a draft", async () => {
    await expect(
      deletePhoto("job-1", "https://blob.vercel-storage.com/other-job.jpg"),
    ).rejects.toThrow("Photo does not belong to this job");
    expect(del).not.toHaveBeenCalled();
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
  });

  it("reads the submitted state when submission wins the row lock", async () => {
    const releaseLock = deferred();
    const job = makeDeletionJob();
    transaction.$queryRaw.mockImplementation(async () => {
      await releaseLock.promise;
      return [structuredClone(job)];
    });
    const deleting = deletePhoto("job-1", DELETE_URL);
    const rejected = expect(deleting).rejects.toThrow("submitted job");
    job.status = "SUBMITTED";
    releaseLock.resolve();
    await rejected;
    expect(del).not.toHaveBeenCalled();
    expect(transaction.job.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a summary save that commits before the deletion gets its row lock", async () => {
    const releaseLock = deferred();
    const job = makeDeletionJob();
    transaction.$queryRaw.mockImplementation(async () => {
      await releaseLock.promise;
      return [structuredClone(job)];
    });
    const deleting = deletePhoto("job-1", DELETE_URL);
    job.formData![Q109_KEY] = [
      {
        text: "NEW successfully saved findings",
        photos: [DELETE_URL, KEEP_URL],
      },
    ];
    releaseLock.resolve();
    await deleting;
    expect(
      transaction.job.updateMany.mock.calls[0][0].data.formData,
    ).toMatchObject({
      [Q109_KEY]: [
        { text: "NEW successfully saved findings", photos: [KEEP_URL] },
      ],
    });
  });

  it("does not overwrite summary edits or submitted data while Blob cleanup waits", async () => {
    const cleanupStarted = deferred();
    const finishCleanup = deferred();
    const job = makeDeletionJob();
    transaction.$queryRaw.mockImplementation(async () => [
      structuredClone(job),
    ]);
    transaction.job.updateMany.mockImplementation(async ({ data }) => {
      Object.assign(job, structuredClone(data));
      return { count: 1 };
    });
    vi.mocked(del).mockImplementation(async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });

    const deleting = deletePhoto("job-1", DELETE_URL);
    await cleanupStarted.promise;
    expect(job.photos.map((photo) => photo.url)).toEqual([KEEP_URL]);
    expect(job.formData![Q109_KEY]).toEqual([
      { text: "Old reinspection findings", photos: [] },
    ]);
    job.formData![Q109_KEY] = [
      { text: "NEW later findings", photos: [KEEP_URL] },
    ];
    job.status = "SUBMITTED";
    const submittedSnapshot = structuredClone(job);
    finishCleanup.resolve();
    await deleting;
    expect(job).toEqual(submittedSnapshot);
    expect(transaction.job.updateMany).toHaveBeenCalledTimes(1);
  });

  it("leaves Blob storage untouched if the database update fails", async () => {
    transaction.job.updateMany.mockRejectedValueOnce(new Error("write failed"));
    await expect(deletePhoto("job-1", DELETE_URL)).rejects.toThrow(
      "write failed",
    );
    expect(del).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("leaves Blob storage untouched if transaction commit fails", async () => {
    runTransaction.mockImplementationOnce(async (action) => {
      await action(transaction);
      throw new Error("commit failed");
    });
    await expect(deletePhoto("job-1", DELETE_URL)).rejects.toThrow(
      "commit failed",
    );
    expect(del).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a zero-row guarded update before Blob cleanup", async () => {
    transaction.job.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(deletePhoto("job-1", DELETE_URL)).rejects.toThrow(
      "Job is no longer editable",
    );
    expect(del).not.toHaveBeenCalled();
  });

  it("preserves null formData when removing an unreferenced photo", async () => {
    transaction.$queryRaw.mockResolvedValueOnce([
      { ...makeDeletionJob(), formData: null },
    ]);
    await deletePhoto("job-1", DELETE_URL);
    expect(transaction.job.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "formData",
    );
  });

  it("reports failed Blob cleanup after a successful removal without restoring old data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(del).mockRejectedValueOnce(new Error("provider request failed"));
    expect(await deletePhoto("job-1", DELETE_URL)).toEqual({
      success: true,
      blobCleanupPending: true,
    });
    expect(transaction.job.updateMany).toHaveBeenCalledTimes(1);
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[deletePhoto] Job job-1: photo removed; Blob cleanup failed",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });
});

describe("setPhotoIncludedInPdf", () => {
  it("writes includedInPdf=false on the matching URL via jsonb_set, preserving siblings (URL params + JSONB literal)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
    } as never);

    await setPhotoIncludedInPdf(
      "job-1",
      "https://blob.vercel-storage.com/p1.jpg",
      false,
    );

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const call = vi.mocked(db.$executeRaw).mock.calls[0];
    const subs = call.slice(1) as unknown[];
    // Substitution order in the action: photoUrl, includedJson, jobId.
    expect(subs[0]).toBe("https://blob.vercel-storage.com/p1.jpg");
    expect(subs[1]).toBe("false");
    expect(subs[2]).toBe("job-1");

    // Verify the SQL uses jsonb_set on a CASE branch keyed by elem->>'url'
    // — that's what guarantees only the matching photo is rewritten and
    // sibling photo objects pass through unchanged. Prisma's tagged-template
    // call shape: call[0] IS the TemplateStringsArray (array-like with join).
    const sql = (call[0] as readonly string[]).join("?");
    expect(sql).toContain("jsonb_set");
    expect(sql).toContain("elem->>'url'");
    expect(sql).toContain("jsonb_array_elements");
    expect(sql).toContain("ORDER BY ordinality");
    expect(sql).toContain("status::text = 'DRAFT'");
    expect(sql).toContain("EXISTS");
    expect(subs[3]).toBe("https://blob.vercel-storage.com/p1.jpg");

    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("writes includedInPdf=true when re-including a previously excluded photo", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
    } as never);

    await setPhotoIncludedInPdf(
      "job-1",
      "https://blob.vercel-storage.com/re-include.jpg",
      true,
    );

    const call = vi.mocked(db.$executeRaw).mock.calls[0];
    const subs = call.slice(1) as unknown[];
    expect(subs[1]).toBe("true");
  });

  it("throws when job not found (findUnique returns null) — guard fires before any SQL", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce(null);

    await expect(
      setPhotoIncludedInPdf(
        "no-job",
        "https://blob.vercel-storage.com/x.jpg",
        false,
      ),
    ).rejects.toThrow("Job not found");
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("throws when row count is 0 (job vanished between findUnique and UPDATE)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
    } as never);
    vi.mocked(db.$executeRaw).mockResolvedValueOnce(0);

    await expect(
      setPhotoIncludedInPdf(
        "ghost-job",
        "https://blob.vercel-storage.com/x.jpg",
        false,
      ),
    ).rejects.toThrow("Job not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTED", "ARCHIVED"])(
    "refuses changing PDF inclusion on a %s job",
    async (status) => {
      vi.mocked(db.job.findUnique).mockResolvedValueOnce({ status } as never);

      await expect(
        setPhotoIncludedInPdf("job-1", DELETE_URL, false),
      ).rejects.toThrow(
        `Cannot change photo PDF inclusion on a ${status.toLowerCase()} job`,
      );
      expect(db.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it.each(["SUBMITTED", "ARCHIVED"])(
    "does not toggle a photo if the job becomes %s after the early read",
    async (status) => {
      const job = { status: "DRAFT", included: true };
      vi.mocked(db.job.findUnique).mockImplementationOnce((async () => {
        const snapshot = { status: job.status };
        job.status = status;
        return snapshot;
      }) as never);
      vi.mocked(db.$executeRaw).mockImplementationOnce((async (
        sql: TemplateStringsArray,
      ) => {
        const statement = sql.join("?");
        if (
          statement.includes("status::text = 'DRAFT'") &&
          job.status !== "DRAFT"
        ) {
          return 0;
        }
        job.included = false;
        return 1;
      }) as never);

      await expect(
        setPhotoIncludedInPdf("job-1", DELETE_URL, false),
      ).rejects.toThrow("no longer editable");
      expect(job.included).toBe(true);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("does not report success for a photo removed before the toggle UPDATE", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
    } as never);
    vi.mocked(db.$executeRaw).mockResolvedValueOnce(0);
    await expect(
      setPhotoIncludedInPdf("job-1", DELETE_URL, false),
    ).rejects.toThrow("photo not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("ALLOWS toggling on an editable copy — the include flag lives on the copy's own job.photos JSON, not on the shared blob (deliberate divergence from deletePhoto's editable-copy guard)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValueOnce({
      status: "DRAFT",
    } as never);

    await setPhotoIncludedInPdf(
      "copy-1",
      "https://blob.vercel-storage.com/shared.jpg",
      false,
    );

    // No throw, SQL ran. The copy's PDF makeup is editable; only the
    // shared blob is off-limits (which this action never touches — no
    // del() call, only a JSON UPDATE on the copy's own row).
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
