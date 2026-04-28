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

  // -------------------------------------------------------------------------
  // Submit Recovery v2: durable lastEmailFailed flag.
  // The flag is set true inside the same atomic write that flips status →
  // SUBMITTED, then cleared to false only after a confirmed Resend success.
  // -------------------------------------------------------------------------

  it("sets lastEmailFailed=true on the SUBMITTED transition (pessimistic)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);

    await submitJob("job-1", "Mike");

    expect(db.job.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUBMITTED",
          lastEmailFailed: true,
        }),
      }),
    );
  });

  it("clears lastEmailFailed to false after a successful Resend send", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);

    const result = await submitJob("job-1", "Mike");

    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(db.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { lastEmailFailed: false },
    });
  });

  it("does not clear lastEmailFailed when Resend returns an error", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { message: "smtp blew up", name: "send_failed" },
    });

    const result = await submitJob("job-1", "Mike");

    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(false);
    // Pessimistic flag stays true — no clear-write should fire.
    const clearCall = vi
      .mocked(db.job.update)
      .mock.calls.find(
        (c) =>
          (c[0] as { data?: { lastEmailFailed?: unknown } })?.data
            ?.lastEmailFailed === false,
      );
    expect(clearCall).toBeUndefined();
  });

  it("does not clear lastEmailFailed when Resend throws", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);
    mockSend.mockRejectedValueOnce(new Error("network down"));

    const result = await submitJob("job-1", "Mike");

    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(false);
    const clearCall = vi
      .mocked(db.job.update)
      .mock.calls.find(
        (c) =>
          (c[0] as { data?: { lastEmailFailed?: unknown } })?.data
            ?.lastEmailFailed === false,
      );
    expect(clearCall).toBeUndefined();
  });

  it("over-warns (emailSent=false) when the clear-write itself fails", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(mockJob() as never);
    // Resend succeeds, but the post-send DB clear throws (e.g. transient hiccup).
    vi.mocked(db.job.update).mockRejectedValueOnce(new Error("db hiccup"));

    const result = await submitJob("job-1", "Mike");

    // Email actually went, but the durable flag couldn't be cleared, so the
    // server reports emailSent=false to keep the toast and durable card
    // consistently conservative.
    expect(result.success).toBe(true);
    expect(result.emailSent).toBe(false);
  });
});
