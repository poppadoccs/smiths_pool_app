import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormData, FormField } from "@/lib/forms";

const mocks = vi.hoisted(() => ({
  readJob: vi.fn(),
  updateJob: vi.fn(),
  updateMany: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  recipient: vi.fn(),
  pdf: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: mocks.readJob,
      update: mocks.updateJob,
      updateMany: mocks.updateMany,
    },
    $executeRaw: mocks.executeRaw,
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/actions/settings", () => ({
  getRecipientEmail: mocks.recipient,
}));
vi.mock("@/lib/actions/generate-pdf", () => ({ generateJobPdf: mocks.pdf }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

import { submitJob } from "@/lib/actions/submit";
import { saveFormData } from "@/lib/actions/forms";
import { saveSummaryItems } from "@/lib/actions/summary";
import {
  REINSPECTION_FIELD_ID,
  RESERVED_REINSPECTION_SUMMARY_KEY,
} from "@/lib/summary";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  return {
    id: "submission-race",
    name: "Submission race test",
    jobNumber: "QA-RACE",
    status: "DRAFT" as "DRAFT" | "SUBMITTED",
    submittedBy: null as string | null,
    submittedAt: null as Date | null,
    workerSignature: null as string | null,
    lastEmailFailed: null as boolean | null,
    photos: [],
    formData: {
      customer_name: "Alice",
      [REINSPECTION_FIELD_ID]: "",
      [RESERVED_REINSPECTION_SUMMARY_KEY]: [
        { text: "OLD_REINSPECTION", photos: [] },
      ],
    } as FormData,
    template: {
      id: "race-template",
      name: "Pool/Spa Inspection",
      fields: [
        {
          id: "customer_name",
          label: "Customer Name",
          type: "text",
          required: true,
          order: 0,
        },
        {
          id: REINSPECTION_FIELD_ID,
          label: "109. Re-Inspection Summary",
          type: "textarea",
          required: false,
          order: 108,
        },
      ] as FormField[],
    },
  };
}

let row: ReturnType<typeof fixture>;
let pdfRow: ReturnType<typeof fixture> | undefined;
let transactionOpen: boolean;
let rowLocked: boolean;
let unlocked: ReturnType<typeof deferred>;
let writerAttempted: ReturnType<typeof deferred>;
let duringSettings: (() => Promise<void>) | undefined;
let afterLockedRead: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  row = fixture();
  pdfRow = undefined;
  transactionOpen = false;
  rowLocked = false;
  unlocked = deferred();
  writerAttempted = deferred();
  duringSettings = undefined;
  afterLockedRead = undefined;

  mocks.readJob.mockImplementation(async () => structuredClone(row));
  mocks.updateJob.mockImplementation(async ({ data }) => {
    Object.assign(row, data);
    return structuredClone(row);
  });
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    if (row.id !== where.id || row.status !== where.status) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });

  // Model ordinary draft writes and row-lock waits, while running the real
  // save actions. The gates below choose the interleaving without timers.
  mocks.executeRaw.mockImplementation(async (_sql, patchJson: string) => {
    writerAttempted.resolve();
    if (rowLocked) await unlocked.promise;
    if (row.status !== "DRAFT") return 0;
    row.formData = { ...row.formData, ...JSON.parse(patchJson) };
    return 1;
  });
  mocks.transaction.mockImplementation(
    async (work: (tx: unknown) => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await work({
          $queryRaw: async (sql: TemplateStringsArray, jobId: string) => {
            expect(sql.join("?")).toMatch(/\bFOR UPDATE\b/);
            expect(jobId).toBe(row.id);
            rowLocked = true;
            return [{ id: row.id }];
          },
          job: {
            findUnique: async () => {
              const snapshot = structuredClone(row);
              await afterLockedRead?.();
              return snapshot;
            },
            updateMany: mocks.updateMany,
          },
        });
      } finally {
        transactionOpen = false;
        rowLocked = false;
        unlocked.resolve();
      }
    },
  );
  mocks.recipient.mockImplementation(async () => {
    expect(transactionOpen).toBe(false);
    await duringSettings?.();
    return "qa@example.invalid";
  });
  mocks.pdf.mockImplementation(async () => {
    expect(transactionOpen).toBe(false);
    expect(row.status).toBe("SUBMITTED");
    pdfRow = structuredClone(row);
    return { success: true, data: "data:application/pdf;base64,JVBER" };
  });
  mocks.send.mockImplementation(async () => {
    expect(transactionOpen).toBe(false);
    return { data: { id: "mock-email" }, error: null };
  });
});

describe("submission uses one current, validated job snapshot", () => {
  it("includes a summary save completed while recipient lookup is pending in both reports", async () => {
    const settingsEntered = deferred();
    const resumeSettings = deferred();
    duringSettings = async () => {
      settingsEntered.resolve();
      await resumeSettings.promise;
    };
    const submitting = submitJob(row.id, "Test worker");
    await settingsEntered.promise;
    const newItems = [{ text: "NEW_REINSPECTION", photos: [] }];
    expect(
      await saveSummaryItems(row.id, newItems, REINSPECTION_FIELD_ID),
    ).toEqual({ success: true });
    resumeSettings.resolve();

    expect(await submitting).toEqual({ success: true, emailSent: true });
    expect(row.formData[RESERVED_REINSPECTION_SUMMARY_KEY]).toEqual(newItems);
    expect(pdfRow?.formData).toEqual(row.formData);
    const email = mocks.send.mock.calls[0][0] as { html: string };
    expect(email.html).toContain("NEW_REINSPECTION");
    expect(email.html).not.toContain("OLD_REINSPECTION");
  });

  it("revalidates a required field cleared by autosave during recipient lookup", async () => {
    const settingsEntered = deferred();
    const resumeSettings = deferred();
    duringSettings = async () => {
      settingsEntered.resolve();
      await resumeSettings.promise;
    };
    const submitting = submitJob(row.id, "Test worker");
    await settingsEntered.promise;
    await saveFormData(row.id, { customer_name: "" });
    resumeSettings.resolve();

    expect(await submitting).toEqual({
      success: false,
      error: "Missing required fields: Customer Name",
    });
    expect(row.status).toBe("DRAFT");
    expect(row.lastEmailFailed).toBeNull();
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects a summary save that reaches the row after the submission lock", async () => {
    const snapshotRead = deferred();
    const resumeSubmission = deferred();
    afterLockedRead = async () => {
      snapshotRead.resolve();
      await resumeSubmission.promise;
    };
    const submitting = submitJob(row.id, "Test worker");
    await snapshotRead.promise;
    const saving = saveSummaryItems(
      row.id,
      [{ text: "TOO_LATE_REINSPECTION", photos: [] }],
      REINSPECTION_FIELD_ID,
    );
    await writerAttempted.promise;
    resumeSubmission.resolve();

    expect(await submitting).toEqual({ success: true, emailSent: true });
    expect(await saving).toEqual({
      success: false,
      error: expect.stringContaining("Job is no longer editable"),
    });
    expect(pdfRow?.formData).toEqual(row.formData);
    const email = mocks.send.mock.calls[0][0] as { html: string };
    expect(email.html).toContain("OLD_REINSPECTION");
    expect(email.html).not.toContain("TOO_LATE_REINSPECTION");
    expect(row.formData[RESERVED_REINSPECTION_SUMMARY_KEY]).toEqual([
      { text: "OLD_REINSPECTION", photos: [] },
    ]);
  });
});
