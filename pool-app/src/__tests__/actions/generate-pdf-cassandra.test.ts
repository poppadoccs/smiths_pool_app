// Coverage for the Cassandra-edits render changes (May 18 client email):
//   - page 1: disclaimers centered, bold job-title block removed
//   - structured summary items: bullets + photos, Q108 accounting, legacy
//     blob path untouched
//   - allowTextFor companion text appended to radio/select display values
import { describe, it, expect, vi, beforeEach } from "vitest";

const pdfTrace = vi.hoisted(() => ({
  textCalls: [] as unknown[][],
  addImageCalls: [] as unknown[][],
  addPageCount: 0,
}));

vi.mock("jspdf", () => {
  class MockDoc {
    constructor(_opts: unknown) {
      pdfTrace.textCalls = [];
      pdfTrace.addImageCalls = [];
      pdfTrace.addPageCount = 0;
    }
    setFont = () => {};
    setFontSize = () => {};
    setLineWidth = () => {};
    setProperties = () => {};
    line = () => {};
    text = (...args: unknown[]) => {
      pdfTrace.textCalls.push(args);
    };
    splitTextToSize = (s: unknown) => (typeof s === "string" ? [s] : [""]);
    addImage = (...args: unknown[]) => {
      pdfTrace.addImageCalls.push(args);
    };
    addPage = () => {
      pdfTrace.addPageCount++;
    };
    getImageProperties = () => ({ width: 100, height: 80 });
    output = () => "stub_base64_pdf_data";
  }
  return { jsPDF: MockDoc };
});

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
    },
  },
}));

import { generateJobPdf } from "@/lib/actions/generate-pdf";
import { db } from "@/lib/db";

const fakeImageBytes = new ArrayBuffer(4);

function photoMeta(url: string, includedInPdf?: boolean) {
  const base = {
    url,
    filename: `${url.split("/").pop() ?? url}.jpg`,
    size: 100,
    uploadedAt: "2026-04-20",
  };
  return includedInPdf === undefined ? base : { ...base, includedInPdf };
}

function okFetchResponse() {
  return { arrayBuffer: async () => fakeImageBytes } as unknown as Response;
}

function fetchedUrls(): string[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map((call) => call[0] as string);
}

function jpegImageCount(): number {
  return pdfTrace.addImageCalls.filter((args) => args[1] === "JPEG").length;
}

function textWasDrawn(target: string): boolean {
  return pdfTrace.textCalls.some((args) => {
    const first = args[0];
    if (Array.isArray(first)) return first.some((line) => line === target);
    return first === target;
  });
}

function drawnCentered(startsWith: string): boolean {
  return pdfTrace.textCalls.some((args) => {
    const first = args[0];
    const opts = args[3] as { align?: string } | undefined;
    const matches = (s: unknown) =>
      typeof s === "string" && s.startsWith(startsWith);
    const hit = Array.isArray(first) ? first.some(matches) : matches(first);
    return hit && opts?.align === "center";
  });
}

function summaryField() {
  return {
    id: "107_summary",
    type: "textarea",
    label: "107. Summary",
    required: false,
    order: 106,
  };
}

function photoField(id: string, order: number, label: string) {
  return { id, type: "photo", label, required: false, order };
}

beforeEach(() => {
  vi.clearAllMocks();
  pdfTrace.textCalls = [];
  pdfTrace.addImageCalls = [];
  pdfTrace.addPageCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => okFetchResponse()),
  );
});

describe("generateJobPdf — first-page layout (client asks #1/#2)", () => {
  it("disclaimers are drawn centered and the bold job-title block is gone", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "SUBMITTED",
      name: "Kimberly Waters",
      jobNumber: "2026-101",
      submittedBy: null,
      submittedAt: null,
      workerSignature: null,
      photos: [],
      formData: { "1_inspection_performed_for": "Kimberly Waters" },
      template: {
        id: "t1",
        name: "Test Template",
        fields: [
          {
            id: "1_inspection_performed_for",
            type: "text",
            label: "1. Inspection performed for",
            required: false,
            order: 0,
          },
        ],
      },
    } as never);

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    // Both disclaimer paragraphs drawn with {align:"center"}.
    expect(drawnCentered("This inspection is for observed condition")).toBe(
      true,
    );
    expect(drawnCentered("Only visible leaks are noted")).toBe(true);

    // The customer's name appears exactly ONCE (as the Q1 value) — the
    // bold title that duplicated it is removed.
    const nameDraws = pdfTrace.textCalls.filter((args) => {
      const first = args[0];
      const matches = (s: unknown) => s === "Kimberly Waters";
      return Array.isArray(first) ? first.some(matches) : matches(first);
    });
    expect(nameDraws).toHaveLength(1);
  });
});

describe("generateJobPdf — structured summary items (client ask #11)", () => {
  function jobWithSummary(overrides: Record<string, unknown> = {}) {
    return {
      id: "job-1",
      status: "DRAFT",
      name: null,
      submittedBy: null,
      submittedAt: null,
      workerSignature: null,
      photos: [
        photoMeta("http://test.local/s1"),
        photoMeta("http://test.local/s2"),
        photoMeta("http://test.local/orphan"),
      ],
      formData: {
        "107_summary": "OLD LEGACY BLOB TEXT",
        __summary_items: [
          { text: "Algae noted on steps", photos: ["http://test.local/s1"] },
          { text: "Loose inlet fitting", photos: ["http://test.local/s2"] },
        ],
        __photoAssignmentsReviewed: true,
      },
      template: {
        id: "t1",
        name: "Test Template",
        fields: [
          summaryField(),
          photoField("108_additional_photos", 108, "108. Additional Photos"),
        ],
      },
      ...overrides,
    };
  }

  it("renders heading, bullet texts, and per-bullet photos; legacy blob NOT rendered", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(jobWithSummary() as never);

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    expect(textWasDrawn("107. Summary")).toBe(true);
    expect(textWasDrawn("Algae noted on steps")).toBe(true);
    expect(textWasDrawn("Loose inlet fitting")).toBe(true);
    // Structured items win: the legacy blob must not render.
    expect(textWasDrawn("OLD LEGACY BLOB TEXT")).toBe(false);

    const urls = fetchedUrls();
    expect(urls).toContain("http://test.local/s1");
    expect(urls).toContain("http://test.local/s2");
  });

  it("summary-claimed photos do NOT also drain under Q108; orphans still do", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(jobWithSummary() as never);

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    const urls = fetchedUrls();
    // Each summary photo fetched exactly once (no Q108 duplication).
    expect(urls.filter((u) => u === "http://test.local/s1")).toHaveLength(1);
    expect(urls.filter((u) => u === "http://test.local/s2")).toHaveLength(1);
    // The unclaimed photo still drains under Q108.
    expect(urls.filter((u) => u === "http://test.local/orphan")).toHaveLength(
      1,
    );
    expect(jpegImageCount()).toBe(3);
  });

  it("excluded (includedInPdf=false) summary photo is not fetched or embedded", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      jobWithSummary({
        photos: [
          photoMeta("http://test.local/s1", false),
          photoMeta("http://test.local/s2"),
          photoMeta("http://test.local/orphan"),
        ],
      }) as never,
    );

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    const urls = fetchedUrls();
    expect(urls).not.toContain("http://test.local/s1");
    expect(urls).toContain("http://test.local/s2");
    expect(jpegImageCount()).toBe(2);
  });

  it("legacy path untouched: no __summary_items → blob renders exactly as before", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      jobWithSummary({
        formData: {
          "107_summary": "OLD LEGACY BLOB TEXT",
          __photoAssignmentsReviewed: true,
        },
      }) as never,
    );

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    expect(textWasDrawn("107. Summary")).toBe(true);
    expect(textWasDrawn("OLD LEGACY BLOB TEXT")).toBe(true);
  });

  it("empty items array renders the heading with an em-dash placeholder", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      jobWithSummary({
        formData: {
          "107_summary": "OLD LEGACY BLOB TEXT",
          __summary_items: [],
          __photoAssignmentsReviewed: true,
        },
      }) as never,
    );

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    expect(textWasDrawn("107. Summary")).toBe(true);
    // Structured-zero: blob does NOT render; placeholder does.
    expect(textWasDrawn("OLD LEGACY BLOB TEXT")).toBe(false);
    expect(textWasDrawn("—")).toBe(true);
  });

  it("summary photo fetch failure surfaces the fallback marker without aborting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://test.local/s1") throw new Error("boom");
        return okFetchResponse();
      }),
    );
    vi.mocked(db.job.findUnique).mockResolvedValue(jobWithSummary() as never);

    const res = await generateJobPdf("job-1");
    expect(res).toEqual({ success: true, data: "stub_base64_pdf_data" });
    expect(textWasDrawn("[photo could not be loaded]")).toBe(true);
    // s2 + orphan still embedded.
    expect(jpegImageCount()).toBe(2);
  });
});

describe("generateJobPdf — paired Main/Secondary fields render as one row", () => {
  it("draws the shared title once with one value line per column, secondary not drawn separately", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      name: null,
      submittedBy: null,
      submittedAt: null,
      workerSignature: null,
      photos: [],
      formData: {
        "7_pump_mfg": "Other",
        "7_pump_mfg_other_text": "Aqua-Flo XT",
        "7_pump_mfg_secondary": "Hayward",
      },
      template: {
        id: "t1",
        name: "Test Template",
        fields: [
          {
            id: "7_pump_mfg",
            type: "radio",
            label: "7. Pump Mfg — Main Pump",
            required: false,
            options: ["Hayward", "Other"],
            allowTextFor: ["Other"],
            order: 0,
          },
          {
            id: "7_pump_mfg_secondary",
            type: "radio",
            label: "7. Pump Mfg — Secondary Pump",
            required: false,
            options: ["Hayward", "Other", "N/a"],
            allowTextFor: ["Other"],
            order: 1,
          },
        ],
      },
    } as never);

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);

    // One combined value block: both column lines in a single draw
    // (the mock's splitTextToSize returns the raw string, \n included).
    expect(
      textWasDrawn("Main Pump: Other — Aqua-Flo XT\nSecondary Pump: Hayward"),
    ).toBe(true);
    // Shared numbered title drawn; per-column labels NOT drawn as rows.
    expect(textWasDrawn("7. Pump Mfg")).toBe(true);
    expect(textWasDrawn("7. Pump Mfg — Main Pump")).toBe(false);
    expect(textWasDrawn("7. Pump Mfg — Secondary Pump")).toBe(false);
  });

  it("unanswered columns render an em-dash per line", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      name: null,
      submittedBy: null,
      submittedAt: null,
      workerSignature: null,
      photos: [],
      formData: {},
      template: {
        id: "t1",
        name: "Test Template",
        fields: [
          {
            id: "8_pump_model",
            type: "text",
            label: "8. Pump Model — Main Pump",
            required: false,
            order: 0,
          },
          {
            id: "8_pump_model_secondary",
            type: "text",
            label: "8. Pump Model — Secondary Pump",
            required: false,
            order: 1,
          },
        ],
      },
    } as never);

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);
    expect(textWasDrawn("Main Pump: —\nSecondary Pump: —")).toBe(true);
    expect(textWasDrawn("8. Pump Model")).toBe(true);
  });
});

describe("generateJobPdf — allowTextFor companion text (client asks #5/#7)", () => {
  function jobWithRadio(formData: Record<string, unknown>) {
    return {
      id: "job-1",
      status: "DRAFT",
      name: null,
      submittedBy: null,
      submittedAt: null,
      workerSignature: null,
      photos: [],
      formData,
      template: {
        id: "t1",
        name: "Test Template",
        fields: [
          {
            id: "9_pump_hp",
            type: "radio",
            label: "9. Pump HP",
            required: false,
            options: ["1.0", "1.5", "2.0", "Variable", "Other"],
            allowTextFor: ["Variable", "Other"],
            order: 0,
          },
        ],
      },
    };
  }

  it("appends companion text when a trigger option is selected", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      jobWithRadio({
        "9_pump_hp": "Variable",
        "9_pump_hp_other_text": "2.7 THP IntelliFlo",
      }) as never,
    );

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);
    expect(textWasDrawn("Variable — 2.7 THP IntelliFlo")).toBe(true);
  });

  it("renders the plain value when a non-trigger option is selected, even with stale companion text", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      jobWithRadio({
        "9_pump_hp": "1.5",
        "9_pump_hp_other_text": "stale text",
      }) as never,
    );

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);
    expect(textWasDrawn("1.5")).toBe(true);
    expect(textWasDrawn("1.5 — stale text")).toBe(false);
  });

  it("renders the plain trigger value when companion text is empty", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(
      jobWithRadio({
        "9_pump_hp": "Other",
        "9_pump_hp_other_text": "   ",
      }) as never,
    );

    const res = await generateJobPdf("job-1");
    expect(res.success).toBe(true);
    expect(textWasDrawn("Other")).toBe(true);
  });
});
