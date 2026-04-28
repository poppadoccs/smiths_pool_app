// Regression Guardrail Pack v1 — pre-change smoke lane.
// Curated re-run of the highest-signal checks from the Cassandra-closeout
// UAT. Mocks-only (same pattern as __tests__/actions/*.test.ts). No DB.
// Run via `npm run smoke`. H (real PDF byte smoke) deferred to v2.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted before imports)
// ---------------------------------------------------------------------------

const mockSend = vi
  .fn()
  .mockResolvedValue({ data: { id: "email-1" }, error: null });
vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: mockSend };
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/actions/generate-pdf", () => ({
  generateJobPdf: vi.fn().mockResolvedValue({
    success: true,
    data: "data:application/pdf;filename=generated.pdf;base64,JVBER",
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.stubEnv("RESEND_API_KEY", "re_test_key");
vi.stubEnv("SUBMISSION_EMAIL", "test@example.com");

import {
  MULTI_PHOTO_CAPS,
  ADDITIONAL_PHOTOS_CAP,
  REMARKS_PHOTO_CAP,
  SOURCE_JOB_ID_KEY,
  isEditableCopy,
} from "@/lib/multi-photo";
import { buildSubmissionEmail } from "@/lib/email";
import { createEditableCopy } from "@/lib/actions/jobs";
import { submitJob } from "@/lib/actions/submit";
import { db } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures (inline — no shared helper file per v1 scope)
// ---------------------------------------------------------------------------

const SOURCE_ID = "src-smoke";
const COPY_ID = "copy-smoke";

function submittedSourceFixture() {
  return {
    id: SOURCE_ID,
    name: "Smoke Source",
    jobNumber: "SMK-1",
    status: "SUBMITTED" as const,
    submittedBy: "Worker",
    submittedAt: new Date("2026-04-20"),
    workerSignature: "data:image/png;base64,abc",
    templateId: "tpl-smoke",
    photos: [
      { url: "http://t/p0", filename: "p0.jpg", size: 1, uploadedAt: "x" },
    ],
    formData: {
      customer_name: "Smoke Customer",
      address: "1 Smoke Ln",
      pool_type: "Inground",
      length: "32",
      width: "16",
    },
    createdAt: new Date("2026-04-20"),
    updatedAt: new Date("2026-04-20"),
  };
}

// Post-copy DRAFT shape — carries the __sourceJobId marker and has the
// required fields submit expects when falling back to DEFAULT_TEMPLATE.
function draftCopyFixture() {
  return {
    id: COPY_ID,
    name: "Smoke Source (copy)",
    jobNumber: "SMK-1",
    status: "DRAFT" as const,
    submittedBy: null,
    submittedAt: null,
    workerSignature: null,
    templateId: null,
    photos: [],
    formData: {
      customer_name: "Smoke Customer",
      address: "1 Smoke Ln",
      pool_type: "Inground",
      length: "32",
      width: "16",
      [SOURCE_JOB_ID_KEY]: SOURCE_ID,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const minimalTemplate = {
  id: "tpl-smoke",
  name: "Smoke",
  version: 1,
  fields: [
    {
      id: "customer_name",
      label: "Customer Name",
      type: "text" as const,
      required: true,
      order: 0,
    },
  ],
};

const minimalFormData = { customer_name: "Smoke" };

// ---------------------------------------------------------------------------
// A + B — invariant constants
// ---------------------------------------------------------------------------

describe("smoke: invariant constants", () => {
  it("caps: MULTI_PHOTO_CAPS, ADDITIONAL_PHOTOS_CAP, REMARKS_PHOTO_CAP match locked v1 values", () => {
    expect(MULTI_PHOTO_CAPS["5_picture_of_pool_and_spa_if_applicable"]).toBe(5);
    expect(MULTI_PHOTO_CAPS["16_photo_of_pool_pump"]).toBe(5);
    expect(MULTI_PHOTO_CAPS["25_picture_of_cartridge"]).toBe(4);
    expect(
      MULTI_PHOTO_CAPS["40_picture_if_leak_is_present_at_chlorinator"],
    ).toBe(5);
    expect(
      MULTI_PHOTO_CAPS["71_picture_of_leaks_on_valves_if_applicable"],
    ).toBe(6);
    expect(ADDITIONAL_PHOTOS_CAP).toBe(7);
    expect(REMARKS_PHOTO_CAP).toBe(8);
  });

  it('SOURCE_JOB_ID_KEY equals "__sourceJobId"', () => {
    expect(SOURCE_JOB_ID_KEY).toBe("__sourceJobId");
  });

  it("isEditableCopy returns true only when formData carries __sourceJobId as a non-empty string", () => {
    expect(isEditableCopy({ [SOURCE_JOB_ID_KEY]: "src-1" })).toBe(true);
    expect(isEditableCopy(null)).toBe(false);
    expect(isEditableCopy({})).toBe(false);
    expect(isEditableCopy({ [SOURCE_JOB_ID_KEY]: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C + D — email HTML shape
// ---------------------------------------------------------------------------

describe("smoke: email HTML", () => {
  it('email HTML: blue "Open editable version" button appears before "Form Details" when editUrl is set', () => {
    const html = buildSubmissionEmail({
      jobTitle: "Smoke",
      jobNumber: null,
      submittedBy: "tester",
      formData: minimalFormData,
      template: minimalTemplate,
      photos: [],
      editUrl: "https://example.com/jobs/abc",
    });
    const idxButton = html.indexOf("Open editable version");
    const idxFormDetails = html.indexOf("Form Details");
    expect(idxButton).toBeGreaterThanOrEqual(0);
    expect(/background:\s*#2563eb/.test(html)).toBe(true);
    expect(idxFormDetails).toBeGreaterThanOrEqual(0);
    expect(idxButton).toBeLessThan(idxFormDetails);
  });

  it("email HTML: helper text and /jobs/<id> href match the locked shape", () => {
    const html = buildSubmissionEmail({
      jobTitle: "Smoke",
      jobNumber: null,
      submittedBy: "tester",
      formData: minimalFormData,
      template: minimalTemplate,
      photos: [],
      editUrl: "https://example.com/jobs/abc",
    });
    expect(
      html.includes(
        "Open this job in the pool forms app so it can be edited and re-sent.",
      ),
    ).toBe(true);
    expect(/href="https:\/\/example\.com\/jobs\/abc"/.test(html)).toBe(true);
  });

  it("email HTML: button is omitted entirely when editUrl is not provided", () => {
    const html = buildSubmissionEmail({
      jobTitle: "Smoke",
      jobNumber: null,
      submittedBy: "tester",
      formData: minimalFormData,
      template: minimalTemplate,
      photos: [],
    });
    expect(html.includes("Open editable version")).toBe(false);
    expect(
      html.includes(
        "Open this job in the pool forms app so it can be edited and re-sent.",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E + F + G — resend flow (mocked)
// ---------------------------------------------------------------------------

describe("smoke: resend flow (mocked)", () => {
  it("createEditableCopy returns {success, newJobId} for a SUBMITTED source", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      submittedSourceFixture() as never,
    );
    vi.mocked(db.job.create).mockResolvedValue({
      id: COPY_ID,
      status: "DRAFT",
    } as never);

    const res = await createEditableCopy(SOURCE_ID);
    expect(res.success).toBe(true);
    expect(res.newJobId).toBe(COPY_ID);
  });

  it("submitJob on a copy returns success, flips status to SUBMITTED, and calls Resend once with a PDF attachment", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(draftCopyFixture() as never);

    const res = await submitJob(COPY_ID, "tester");
    expect(res.success).toBe(true);
    expect(res.emailSent).toBe(true);
    expect(db.job.updateMany).toHaveBeenCalledWith({
      where: { id: COPY_ID, status: { not: "SUBMITTED" } },
      data: expect.objectContaining({
        status: "SUBMITTED",
        submittedBy: "tester",
      }),
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSend.mock.calls[0][0] as {
      attachments?: Array<{ contentType?: string }>;
    };
    expect(sendArg.attachments?.length).toBe(1);
    expect(sendArg.attachments?.[0].contentType).toBe("application/pdf");
  });

  it("createEditableCopy + submit-of-copy never writes to the source row (no db.job.update/updateMany with source id)", async () => {
    // Route findUnique by id so the single mock handles both calls.
    vi.mocked(db.job.findUnique).mockImplementation((async (args: {
      where: { id: string };
    }) => {
      if (args.where.id === SOURCE_ID) return submittedSourceFixture();
      if (args.where.id === COPY_ID) return draftCopyFixture();
      return null;
    }) as never);
    vi.mocked(db.job.create).mockResolvedValue({
      id: COPY_ID,
      status: "DRAFT",
    } as never);

    const copyRes = await createEditableCopy(SOURCE_ID);
    expect(copyRes.newJobId).toBe(COPY_ID);
    const submitRes = await submitJob(COPY_ID, "tester");
    expect(submitRes.success).toBe(true);

    // Assert: no write to the source. update (singular) and updateMany may
    // fire (Submit Recovery v2 clears lastEmailFailed via update on a
    // successful send) but must never target the source row.
    for (const call of vi.mocked(db.job.update).mock.calls) {
      const where = (call[0] as { where: { id: string } }).where;
      expect(where.id).not.toBe(SOURCE_ID);
    }
    for (const call of vi.mocked(db.job.updateMany).mock.calls) {
      const where = (call[0] as { where: { id: string } }).where;
      expect(where.id).not.toBe(SOURCE_ID);
    }
  });

  it("submitJob on email-failure: still flips status to SUBMITTED but returns emailSent: false", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(draftCopyFixture() as never);
    // One-shot override: Resend returns a relay-style error for this single
    // send. mockResolvedValueOnce reverts to the default happy-path mock
    // afterward so no other test inherits the broken state.
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { name: "relay_error", message: "SMTP unavailable" },
    } as never);

    const res = await submitJob(COPY_ID, "tester");

    expect(res.success).toBe(true);
    expect(res.emailSent).toBe(false);
    // DB flip must still land — the job must persist as SUBMITTED even when
    // the subsequent email send fails. This is the core SUBM-07 invariant.
    expect(db.job.updateMany).toHaveBeenCalledWith({
      where: { id: COPY_ID, status: { not: "SUBMITTED" } },
      data: expect.objectContaining({
        status: "SUBMITTED",
        submittedBy: "tester",
      }),
    });
  });

  it("submitJob on email-throw: still flips status to SUBMITTED but returns emailSent: false", async () => {
    // Second SUBM-07 invariant: when the Resend SDK throws/rejects (network
    // down, malformed payload, etc.) AFTER the DB flip, the worker must see
    // the same emailSent: false outcome — not a generic server-action error.
    vi.mocked(db.job.findUnique).mockResolvedValue(draftCopyFixture() as never);
    mockSend.mockRejectedValueOnce(new Error("network down"));

    const res = await submitJob(COPY_ID, "tester");

    expect(res.success).toBe(true);
    expect(res.emailSent).toBe(false);
    expect(db.job.updateMany).toHaveBeenCalledWith({
      where: { id: COPY_ID, status: { not: "SUBMITTED" } },
      data: expect.objectContaining({
        status: "SUBMITTED",
        submittedBy: "tester",
      }),
    });
  });
});
