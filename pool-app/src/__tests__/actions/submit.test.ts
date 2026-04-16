import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Resend — must be a real class since submit.ts uses `new Resend()`
const mockSend = vi
  .fn()
  .mockResolvedValue({ data: { id: "email-1" }, error: null });
vi.mock("resend", () => {
  return {
    Resend: class MockResend {
      emails = { send: mockSend };
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

// jsPDF emits data:application/pdf;filename=generated.pdf;base64,...
vi.mock("@/lib/actions/generate-pdf", () => ({
  generateJobPdf: vi.fn().mockResolvedValue({
    success: true,
    data: "data:application/pdf;filename=generated.pdf;base64,JVBER",
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Set env before importing the module
vi.stubEnv("RESEND_API_KEY", "re_test_key");
vi.stubEnv("SUBMISSION_EMAIL", "test@example.com");

import { submitJob } from "@/lib/actions/submit";
import { db } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
});

function mockJob(overrides = {}) {
  return {
    id: "job-1",
    name: "Test Job",
    jobNumber: "2024-001",
    status: "DRAFT",
    submittedBy: null,
    submittedAt: null,
    photos: [],
    formData: {
      customer_name: "Alice",
      address: "123 Main",
      pool_type: "Inground",
      length: "32",
      width: "16",
      has_pump: false,
      has_filter: false,
      has_heater: false,
      has_lights: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("submitJob", () => {
  it("sends email and updates job status to SUBMITTED", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);

    const result = await submitJob("job-1", "Mike");

    expect(result.success).toBe(true);
    expect(db.job.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: { not: "SUBMITTED" } },
      data: expect.objectContaining({
        status: "SUBMITTED",
        submittedBy: "Mike",
      }),
    });
  });

  it("returns error when job not found", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(null);

    const result = await submitJob("bad-id", "Mike");
    expect(result).toEqual({ success: false, error: "Job not found" });
  });

  it("prevents double submission", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      mockJob({ status: "SUBMITTED" }) as never,
    );

    const result = await submitJob("job-1", "Mike");
    expect(result.success).toBe(false);
    expect(result.error).toContain("already been submitted");
  });

  it("rejects when form data is empty", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      mockJob({ formData: null }) as never,
    );

    const result = await submitJob("job-1", "Mike");
    expect(result.success).toBe(false);
    expect(result.error).toContain("fill out the form");
  });

  it("rejects when required fields are missing", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      mockJob({
        formData: { customer_name: "", address: "123 Main" },
      }) as never,
    );

    const result = await submitJob("job-1", "Mike");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Missing required fields");
    expect(result.error).toContain("Customer Name");
  });

  it("calls Resend with correct parameters", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);

    await submitJob("job-1", "Mike");

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Pool Field Forms <forms@mail.lucacllc.com>",
        to: ["test@example.com"],
        subject: "Job Submission: Test Job",
      }),
    );
  });
});
