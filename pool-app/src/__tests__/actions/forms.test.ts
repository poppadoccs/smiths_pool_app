import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { saveFormData } from "@/lib/actions/forms";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveFormData", () => {
  it("saves form data to the job", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      formData: null,
    } as never);

    const formData = { customer_name: "Alice", pool_type: "Inground" };
    await saveFormData("job-1", formData);

    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { formData },
    });
  });

  it("overwrites existing form data", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      formData: { customer_name: "Old" },
    } as never);

    const formData = { customer_name: "New", address: "123 Main" };
    await saveFormData("job-1", formData);

    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { formData },
    });
  });

  it("revalidates the job path", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      formData: null,
    } as never);

    await saveFormData("job-1", { name: "Test" });

    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("throws when job not found", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(null);

    await expect(saveFormData("bad-id", {})).rejects.toThrow("Job not found");
  });
});
