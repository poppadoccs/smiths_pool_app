import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      create: vi.fn().mockResolvedValue({ id: "test-id", status: "DRAFT" }),
      findUnique: vi.fn(),
    },
    formTemplate: {
      findFirst: vi.fn().mockResolvedValue({ id: "tpl-default-from-db" }),
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { createJob, createEditableCopy } from "@/lib/actions/jobs";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createJob", () => {
  it("creates job with name", async () => {
    const formData = new FormData();
    formData.set("name", "Smith Residence");

    const result = await createJob(null, formData);

    expect(db.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Smith Residence",
        status: "DRAFT",
      }),
    });
    expect(result).toEqual({ success: true });
  });

  it("creates job with jobNumber", async () => {
    const formData = new FormData();
    formData.set("jobNumber", "2024-042");

    const result = await createJob(null, formData);

    expect(db.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobNumber: "2024-042",
      }),
    });
    expect(result).toEqual({ success: true });
  });

  it("returns error when neither name nor jobNumber", async () => {
    const formData = new FormData();

    const result = await createJob(null, formData);

    expect(result).toHaveProperty("error");
    expect(db.job.create).not.toHaveBeenCalled();
  });

  it("calls revalidatePath on success", async () => {
    const formData = new FormData();
    formData.set("name", "Test Job");

    await createJob(null, formData);

    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns success on valid create", async () => {
    const formData = new FormData();
    formData.set("name", "Another Job");
    formData.set("jobNumber", "2024-099");

    const result = await createJob(null, formData);

    expect(result).toEqual({ success: true });
  });

  it("preserves explicit templateId when supplied by the form", async () => {
    const formData = new FormData();
    formData.set("name", "Smith Residence");
    formData.set("templateId", "tpl-explicit-pick");

    await createJob(null, formData);

    // Explicit selection wins — the DB default lookup must not be used.
    expect(db.formTemplate.findFirst).not.toHaveBeenCalled();
    expect(db.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateId: "tpl-explicit-pick",
      }),
    });
  });

  it("falls back to the DB default template when no templateId is supplied", async () => {
    vi.mocked(db.formTemplate.findFirst).mockResolvedValueOnce({
      id: "tpl-default-from-db",
    } as never);
    const formData = new FormData();
    formData.set("name", "No Template Picked");

    await createJob(null, formData);

    expect(db.formTemplate.findFirst).toHaveBeenCalledWith({
      where: { isDefault: true },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(db.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateId: "tpl-default-from-db",
        status: "DRAFT",
      }),
    });
  });

  it("falls back to templateId=null only when no DB default template exists", async () => {
    vi.mocked(db.formTemplate.findFirst).mockResolvedValueOnce(null);
    const formData = new FormData();
    formData.set("name", "Fresh DB With No Default");

    await createJob(null, formData);

    expect(db.formTemplate.findFirst).toHaveBeenCalled();
    const createArgs = vi.mocked(db.job.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // No templateId key on the create payload — preserves legacy fallback.
    expect(createArgs.data).not.toHaveProperty("templateId");
    expect(createArgs.data.status).toBe("DRAFT");
  });

  it("does not include formData or photos on the create payload (job-data mutation guard)", async () => {
    const formData = new FormData();
    formData.set("name", "Just A Name");

    await createJob(null, formData);

    const createArgs = vi.mocked(db.job.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // createJob writes only the fresh-DRAFT shape — never seeds formData
    // or photos. This guard catches accidental wiring of either column.
    expect(createArgs.data).not.toHaveProperty("formData");
    expect(createArgs.data).not.toHaveProperty("photos");
  });
});

describe("createEditableCopy", () => {
  // Typical submitted-job snapshot: full multi-photo ownership graph —
  // Q5 map with two slots + legacy mirror for slot 0, Q108 map-only,
  // R15 remarks-photo owner map-only, reviewed flag set.
  function submittedSource() {
    return {
      id: "src-1",
      name: "Hennessy Pool",
      jobNumber: "1413",
      status: "SUBMITTED" as const,
      submittedBy: "Worker",
      submittedAt: new Date("2026-04-17"),
      workerSignature: "data:image/png;base64,abc",
      templateId: "tpl-real",
      photos: [
        { url: "http://test/p0", filename: "p0.jpg", size: 1, uploadedAt: "x" },
        { url: "http://test/p1", filename: "p1.jpg", size: 1, uploadedAt: "x" },
        { url: "http://test/p2", filename: "p2.jpg", size: 1, uploadedAt: "x" },
        { url: "http://test/p3", filename: "p3.jpg", size: 1, uploadedAt: "x" },
      ],
      formData: {
        "5_picture_of_pool_and_spa_if_applicable": "http://test/p0",
        "15_remarks_notes": "seep at pump",
        __photoAssignmentsByField: {
          "5_picture_of_pool_and_spa_if_applicable": [
            "http://test/p0",
            "http://test/p1",
          ],
          "108_additional_photos": ["http://test/p2"],
          "15_remarks_notes_photos": ["http://test/p3"],
        },
        __photoAssignmentsReviewed: true,
      },
      createdAt: new Date("2026-04-17"),
      updatedAt: new Date("2026-04-17"),
    };
  }

  it("creates a DRAFT copy with photos + formData carried over including the map, plus the __sourceJobId marker", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(submittedSource() as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: "copy-1",
      status: "DRAFT",
    } as never);

    const res = await createEditableCopy("src-1");

    expect(res).toEqual({ success: true, newJobId: "copy-1" });
    const createArgs = vi.mocked(db.job.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data.status).toBe("DRAFT");
    expect(createArgs.data.templateId).toBe("tpl-real");
    expect(createArgs.data.name).toBe("Hennessy Pool (copy)");
    expect(createArgs.data.jobNumber).toBe("1413");
    // Photos preserved 1:1.
    expect(createArgs.data.photos).toEqual(submittedSource().photos);
    // formData preserved — map + mirror + remarks owner + Q108 map entry +
    // reviewed flag all carry over, with __sourceJobId added on top.
    expect(createArgs.data.formData).toEqual({
      ...submittedSource().formData,
      __sourceJobId: "src-1",
    });
    // Submitted-only fields are NOT set on the new draft.
    expect(createArgs.data).not.toHaveProperty("submittedBy");
    expect(createArgs.data).not.toHaveProperty("submittedAt");
    expect(createArgs.data).not.toHaveProperty("workerSignature");
  });

  it("does NOT mutate the source record (no db.job.update call)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(submittedSource() as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: "copy-1",
      status: "DRAFT",
    } as never);

    // Guard against accidental update wiring: any such call should fail
    // because the mock hasn't defined update at all.
    const dbMock = db as unknown as { job: Record<string, unknown> };
    expect(dbMock.job.update).toBeUndefined();
    expect(dbMock.job.updateMany).toBeUndefined();

    const res = await createEditableCopy("src-1");
    expect(res.success).toBe(true);
  });

  it("clones formData by value so mutating the new record cannot reach the source in memory", async () => {
    // Source contains a nested map. Post-clone, changing the cloned
    // map must not affect the source's map object.
    const src = submittedSource();
    vi.mocked(db.job.findUnique).mockResolvedValue(src as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: "copy-1",
      status: "DRAFT",
    } as never);

    await createEditableCopy("src-1");
    const createArgs = vi.mocked(db.job.create).mock.calls[0][0] as {
      data: { formData: Record<string, unknown> };
    };
    const clonedMap = createArgs.data.formData
      .__photoAssignmentsByField as Record<string, string[]>;
    clonedMap["5_picture_of_pool_and_spa_if_applicable"].push("http://mutant");

    const srcMap = src.formData.__photoAssignmentsByField[
      "5_picture_of_pool_and_spa_if_applicable"
    ] as string[];
    expect(srcMap).toEqual(["http://test/p0", "http://test/p1"]);
    expect(srcMap).not.toContain("http://mutant");
  });

  it("rejects when source is not SUBMITTED", async () => {
    const draft = { ...submittedSource(), status: "DRAFT" as const };
    vi.mocked(db.job.findUnique).mockResolvedValue(draft as never);

    const res = await createEditableCopy("src-1");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/submitted/i);
    expect(db.job.create).not.toHaveBeenCalled();
  });

  it("rejects when source job does not exist", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(null);

    const res = await createEditableCopy("missing");

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
    expect(db.job.create).not.toHaveBeenCalled();
  });

  it("revalidates both the root list and the new job page", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(submittedSource() as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: "copy-1",
      status: "DRAFT",
    } as never);

    await createEditableCopy("src-1");

    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(revalidatePath).toHaveBeenCalledWith("/jobs/copy-1");
  });

  it("handles a source job with null formData — copy still gets the __sourceJobId marker on an otherwise empty formData", async () => {
    const src = {
      ...submittedSource(),
      formData: null as unknown as Record<string, unknown>,
    };
    vi.mocked(db.job.findUnique).mockResolvedValue(src as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: "copy-1",
      status: "DRAFT",
    } as never);

    const res = await createEditableCopy("src-1");

    expect(res.success).toBe(true);
    const createArgs = vi.mocked(db.job.create).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // Null source formData still produces a non-null formData on the copy
    // so the marker can ride in it — the copy must carry the guard even
    // for jobs created before formData was populated.
    expect(createArgs.data.formData).toEqual({ __sourceJobId: "src-1" });
    // Photos still carried over.
    expect(createArgs.data.photos).toEqual(src.photos);
  });

  it("writes the __sourceJobId marker pointing at the source id so the UI can detect copy-ness", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(submittedSource() as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: "copy-1",
      status: "DRAFT",
    } as never);

    await createEditableCopy("src-1");
    const createArgs = vi.mocked(db.job.create).mock.calls[0][0] as {
      data: { formData: Record<string, unknown> };
    };
    // Exactly the source's id, under the reserved `__`-prefixed key.
    expect(createArgs.data.formData.__sourceJobId).toBe("src-1");
  });
});

describe("isEditableCopy helper", () => {
  it("returns true when formData carries a non-empty __sourceJobId string", async () => {
    const { isEditableCopy } = await import("@/lib/multi-photo");
    expect(isEditableCopy({ __sourceJobId: "src-42" })).toBe(true);
  });

  it("returns false when the marker is missing, empty, or non-string", async () => {
    const { isEditableCopy } = await import("@/lib/multi-photo");
    expect(isEditableCopy(null)).toBe(false);
    expect(isEditableCopy(undefined)).toBe(false);
    expect(isEditableCopy({})).toBe(false);
    expect(isEditableCopy({ __sourceJobId: "" })).toBe(false);
    expect(isEditableCopy({ __sourceJobId: 42 as unknown as string })).toBe(
      false,
    );
  });
});
