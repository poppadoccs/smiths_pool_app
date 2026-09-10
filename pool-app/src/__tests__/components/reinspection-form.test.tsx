import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/actions/forms", () => ({
  saveFormData: vi.fn(async () => undefined),
}));
vi.mock("@/lib/actions/photos", () => ({ savePhotoMetadata: vi.fn() }));
vi.mock("@/lib/actions/photo-assignments", () => ({
  assignRemarksFieldPhotos: vi.fn(),
}));
vi.mock("@/lib/actions/summary", () => ({
  saveSummaryItems: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/components/import-from-paper", () => ({
  ImportFromPaper: () => null,
}));
vi.mock("@/components/sticky-form-nav", () => ({ StickyFormNav: () => null }));
import { JobForm } from "@/components/job-form";
import { saveSummaryItems } from "@/lib/actions/summary";
import {
  REINSPECTION_FIELD_ID as Q109,
  RESERVED_REINSPECTION_SUMMARY_KEY as KEY,
  REINSPECTION_LABEL,
} from "@/lib/reinspection";
import {
  SUMMARY_FIELD_ID as Q107,
  RESERVED_SUMMARY_KEY,
  summaryKeyFor,
  SUMMARY_TEXT_MAX_LENGTH,
} from "@/lib/summary";
import type { FormData, FormTemplate } from "@/lib/forms";

const template: FormTemplate = {
  id: "t",
  name: "Pool/Spa Inspection",
  version: 1,
  fields: [
    {
      id: Q107,
      label: "107. Summary",
      type: "textarea",
      required: false,
      order: 106,
    },
    {
      id: Q109,
      label: REINSPECTION_LABEL,
      type: "textarea",
      required: false,
      order: 108,
    },
  ],
};
const photos = ["original", "reinspection"].map((name) => ({
  url: `https://test/${name}.jpg`,
  filename: `${name}.jpg`,
  size: 1,
  uploadedAt: "2026-09-10",
}));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

function section(label: string) {
  return within(screen.getByRole("group", { name: label }));
}

describe("Q109 reuses the Q107 editor", () => {
  it("provides matching empty states and bullet-list controls for both optional sections", () => {
    render(<JobForm jobId="empty" template={template} initialData={null} />);
    for (const label of ["107. Summary", REINSPECTION_LABEL]) {
      expect(section(label).getByText("No summary yet.")).toBeTruthy();
      fireEvent.click(
        section(label).getByRole("button", { name: "Start bullet list" }),
      );
      expect(
        section(label).getByRole("button", { name: "Add bullet point" }),
      ).toBeTruthy();
      expect(section(label).getByRole("textbox").hasAttribute("required")).toBe(
        false,
      );
      expect(
        section(label).getByRole("textbox").getAttribute("maxlength"),
      ).toBe(String(SUMMARY_TEXT_MAX_LENGTH));
    }
  });

  it("edits, attaches, reorders, removes, and reopens Q109 without changing Q107", async () => {
    const saved: FormData = {
      [RESERVED_SUMMARY_KEY]: [
        { text: "Original findings", photos: [photos[0].url] },
      ],
    };
    vi.mocked(saveSummaryItems).mockImplementation(
      async (_jobId, items, fieldId = Q107) => {
        saved[summaryKeyFor(fieldId)!] = structuredClone(items);
        return { success: true };
      },
    );
    const first = render(
      <JobForm
        jobId="both"
        template={template}
        initialData={saved}
        jobPhotos={photos}
      />,
    );
    fireEvent.click(
      section(REINSPECTION_LABEL).getByRole("button", {
        name: "Start bullet list",
      }),
    );
    const notes = section(REINSPECTION_LABEL).getByRole("textbox");
    fireEvent.change(notes, { target: { value: "Leak repaired" } });
    fireEvent.blur(notes);
    await waitFor(() =>
      expect(saveSummaryItems).toHaveBeenLastCalledWith(
        "both",
        [{ text: "Leak repaired", photos: [] }],
        Q109,
      ),
    );
    fireEvent.click(
      section(REINSPECTION_LABEL).getByRole("button", {
        name: "Add photo (0 of 8)",
      }),
    );
    fireEvent.click(
      section(REINSPECTION_LABEL).getByRole("button", {
        name: "Attach reinspection.jpg to this bullet",
      }),
    );
    await waitFor(() =>
      expect(saveSummaryItems).toHaveBeenLastCalledWith(
        "both",
        [{ text: "Leak repaired", photos: [photos[1].url] }],
        Q109,
      ),
    );
    fireEvent.click(
      section(REINSPECTION_LABEL).getByRole("button", {
        name: "Add bullet point",
      }),
    );
    const second = section(REINSPECTION_LABEL).getAllByRole("textbox")[1];
    fireEvent.change(second, { target: { value: "Retested successfully" } });
    fireEvent.blur(second);
    fireEvent.click(
      section(REINSPECTION_LABEL).getAllByRole("button", {
        name: "Move bullet up",
      })[1],
    );
    await waitFor(() =>
      expect(saved[KEY]).toEqual([
        { text: "Retested successfully", photos: [] },
        { text: "Leak repaired", photos: [photos[1].url] },
      ]),
    );
    expect(
      section("107. Summary").getByDisplayValue("Original findings"),
    ).toBeTruthy();
    first.unmount();
    localStorage.clear();
    render(
      <JobForm
        jobId="both"
        template={template}
        initialData={saved}
        jobPhotos={photos}
      />,
    );
    expect(
      section(REINSPECTION_LABEL)
        .getAllByRole("textbox")
        .map((el) => (el as HTMLTextAreaElement).value),
    ).toEqual(["Retested successfully", "Leak repaired"]);
    fireEvent.click(
      section(REINSPECTION_LABEL).getByRole("button", {
        name: "Remove reinspection.jpg from this bullet",
      }),
    );
    fireEvent.click(
      section(REINSPECTION_LABEL).getAllByRole("button", {
        name: "Remove bullet",
      })[0],
    );
    await waitFor(() =>
      expect(saved[KEY]).toEqual([{ text: "Leak repaired", photos: [] }]),
    );
    expect(saved[RESERVED_SUMMARY_KEY]).toEqual([
      { text: "Original findings", photos: [photos[0].url] },
    ]);
    expect(
      vi
        .mocked(saveSummaryItems)
        .mock.calls.every(([, , field]) => field === Q109),
    ).toBe(true);
  });

  it("disables editing in both sections for a submitted form", () => {
    render(
      <JobForm
        jobId="submitted"
        template={template}
        initialData={{
          [RESERVED_SUMMARY_KEY]: [{ text: "Original", photos: [] }],
          [KEY]: [{ text: "Reinspection", photos: [] }],
        }}
        disabled
      />,
    );
    for (const label of ["107. Summary", REINSPECTION_LABEL]) {
      expect(
        (section(label).getByRole("textbox") as HTMLTextAreaElement).disabled,
      ).toBe(true);
      expect(
        section(label).queryByRole("button", { name: "Add bullet point" }),
      ).toBeNull();
    }
  });
});
