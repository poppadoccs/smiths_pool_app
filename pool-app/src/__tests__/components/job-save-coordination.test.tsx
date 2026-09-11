import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/actions/forms", () => ({
  saveFormData: vi.fn(async () => undefined),
}));
vi.mock("@/lib/actions/photos", () => ({ savePhotoMetadata: vi.fn() }));
vi.mock("@/lib/actions/photo-assignments", () => ({
  assignRemarksFieldPhotos: vi.fn(async () => ({ success: true })),
  savePhotoAssignments: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/lib/actions/summary", () => ({
  saveSummaryItems: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/lib/actions/submit", () => ({
  submitJob: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/components/import-from-paper", () => ({
  ImportFromPaper: () => null,
}));
vi.mock("browser-image-compression", () => ({
  default: vi.fn(async (file: File) => file),
}));
vi.mock("@/components/signature-pad", () => ({
  SignaturePad: ({ onEnd }: { onEnd: (data: string) => void }) => (
    <button onClick={() => onEnd("data:image/png;base64,signature")}>
      Sign
    </button>
  ),
}));
vi.mock("@/components/ui/dialog", () => {
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) =>
      open ? <div>{children}</div> : null,
    DialogContent: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogFooter: Container,
  };
});

import { JobForm } from "@/components/job-form";
import { JobSaveProvider } from "@/components/job-save-provider";
import { SubmitSection } from "@/components/submit-section";
import { PhotoAssignmentsEditor } from "@/components/photo-assignments";
import { saveSummaryItems } from "@/lib/actions/summary";
import { saveFormData } from "@/lib/actions/forms";
import { submitJob } from "@/lib/actions/submit";
import {
  assignRemarksFieldPhotos,
  savePhotoAssignments,
} from "@/lib/actions/photo-assignments";
import { toast } from "sonner";
import { loadFormDraft, loadSummaryDraft } from "@/lib/form-draft";
import {
  SUMMARY_FIELD_ID as Q107,
  REINSPECTION_FIELD_ID as Q109,
  RESERVED_SUMMARY_KEY as K107,
  RESERVED_REINSPECTION_SUMMARY_KEY as K109,
} from "@/lib/summary";
import type { FormData, FormTemplate } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";

const label109 = "109. Re-Inspection Summary";
const template: FormTemplate = {
  id: "t",
  name: "Pool/Spa Inspection",
  version: 1,
  fields: [
    { id: "notes", label: "Notes", type: "text", required: false, order: 0 },
    {
      id: Q107,
      label: "107. Summary",
      type: "textarea",
      required: false,
      order: 106,
    },
    {
      id: Q109,
      label: label109,
      type: "textarea",
      required: false,
      order: 108,
    },
  ],
};
const initialData: FormData = {
  notes: "Server notes",
  [K107]: [{ text: "Original findings", photos: [] }],
  [K109]: [{ text: "Prior reinspection", photos: [] }],
};

function Job({
  data = initialData,
  photos = [],
  disabled = false,
  formTemplate = template,
  withAssignments = false,
}: {
  data?: FormData;
  photos?: PhotoMetadata[];
  disabled?: boolean;
  formTemplate?: FormTemplate;
  withAssignments?: boolean;
}) {
  return (
    <JobSaveProvider>
      {withAssignments && (
        <PhotoAssignmentsEditor
          jobId="probe"
          photos={photos}
          template={formTemplate}
          initialFormData={data}
        />
      )}
      <JobForm
        jobId="probe"
        template={formTemplate}
        initialData={data}
        jobPhotos={photos}
        disabled={disabled}
      />
      {!disabled && <SubmitSection jobId="probe" />}
    </JobSaveProvider>
  );
}

const section = (label = label109) =>
  within(screen.getByRole("group", { name: label }));
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
function edit(text: string, label = label109, blur = false) {
  const input = section(label).getByRole("textbox");
  fireEvent.change(input, { target: { value: text } });
  if (blur) fireEvent.blur(input);
}
function prepareSubmission() {
  fireEvent.change(screen.getByRole("textbox", { name: /Your Name/ }), {
    target: { value: "Worker" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign" }));
}
function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Submit for Review" }));
  fireEvent.click(screen.getByRole("button", { name: "Yes, Submit" }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(saveSummaryItems).mockResolvedValue({ success: true });
  vi.mocked(saveFormData).mockResolvedValue(undefined);
  vi.mocked(submitJob).mockResolvedValue({ success: true });
  vi.mocked(assignRemarksFieldPhotos).mockResolvedValue({ success: true });
  vi.mocked(savePhotoAssignments).mockResolvedValue({ success: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("coordinated job saving", () => {
  it("reconciles a refreshed legacy photo clear without resetting unsaved notes", async () => {
    const photo = {
      url: "https://test/old.jpg",
      filename: "old.jpg",
      size: 1,
      uploadedAt: "2026-09-11",
    };
    const photoTemplate: FormTemplate = {
      ...template,
      fields: [
        ...template.fields,
        {
          id: "legacy_photo",
          label: "Legacy photo",
          type: "photo",
          required: false,
          order: 109,
        },
      ],
    };
    const view = render(
      <Job
        formTemplate={photoTemplate}
        data={{ ...initialData, legacy_photo: photo.url }}
        photos={[photo]}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Unsaved normal text" },
    });
    edit("Unsaved summary text");
    // The photo may still be on the job after moving to another owner;
    // the refreshed field mirror, rather than metadata removal, is decisive.
    view.rerender(
      <Job
        formTemplate={photoTemplate}
        data={{ ...initialData, legacy_photo: "" }}
        photos={[photo]}
      />,
    );
    expect(screen.getByLabelText("Legacy photo")).toBeTruthy();
    expect(screen.getByDisplayValue("Unsaved normal text")).toBeTruthy();
    expect(section().getByDisplayValue("Unsaved summary text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({
        legacy_photo: "",
        notes: "Unsaved normal text",
      }),
    );
  });

  it("preserves a newer uploaded photo when a refresh clears the previous server selection", async () => {
    const upload = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => upload.promise),
    );
    const oldPhoto = {
      url: "https://test/old.jpg",
      filename: "old.jpg",
      size: 1,
      uploadedAt: "2026-09-11",
    };
    const newPhoto = {
      ...oldPhoto,
      url: "https://test/new.jpg",
      filename: "new.jpg",
    };
    const photoTemplate: FormTemplate = {
      ...template,
      fields: [
        ...template.fields,
        {
          id: "legacy_photo",
          label: "Legacy photo",
          type: "photo",
          required: false,
          order: 109,
        },
      ],
    };
    const view = render(
      <Job
        formTemplate={photoTemplate}
        data={{ ...initialData, legacy_photo: "" }}
        photos={[oldPhoto]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Legacy photo"), {
      target: {
        files: [new File(["photo"], "new.jpg", { type: "image/jpeg" })],
      },
    });
    await settle();
    // An older assignment arrives while the upload is still in flight.
    view.rerender(
      <Job
        formTemplate={photoTemplate}
        data={{ ...initialData, legacy_photo: oldPhoto.url }}
        photos={[oldPhoto]}
      />,
    );
    upload.resolve({ ok: true, json: async () => newPhoto } as Response);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Newer local note" },
    });
    // Removing that older photo must not clear the new local selection.
    view.rerender(
      <Job
        formTemplate={photoTemplate}
        data={{ ...initialData, legacy_photo: "" }}
        photos={[newPhoto]}
      />,
    );
    expect(screen.getByText("Photo captured")).toBeTruthy();
    expect(screen.getByDisplayValue("Newer local note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({
        legacy_photo: newPhoto.url,
        notes: "Newer local note",
      }),
    );
  });

  it("Submit saves unclicked legacy assignment edits, then synchronizes their RHF mirror", async () => {
    const assignment = deferred<{ success: boolean }>();
    vi.mocked(savePhotoAssignments).mockImplementationOnce(
      () => assignment.promise,
    );
    const photo = {
      url: "https://test/pool.jpg",
      filename: "pool.jpg",
      size: 1,
      uploadedAt: "2026-09-11",
    };
    const photoTemplate: FormTemplate = {
      ...template,
      fields: [
        ...template.fields,
        {
          id: "legacy_photo",
          label: "Legacy photo",
          type: "photo",
          required: false,
          order: 109,
        },
      ],
    };
    render(
      <Job formTemplate={photoTemplate} photos={[photo]} withAssignments />,
    );
    prepareSubmission();
    fireEvent.change(screen.getByLabelText("Assignment for pool.jpg"), {
      target: { value: "legacy_photo" },
    });
    edit("Latest reinspection");
    submit();
    await settle();
    expect(savePhotoAssignments).toHaveBeenCalledWith("probe", {
      [photo.url]: "legacy_photo",
    });
    expect(saveFormData).not.toHaveBeenCalled();
    expect(submitJob).not.toHaveBeenCalled();
    assignment.resolve({ success: true });
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({ legacy_photo: photo.url }),
    );
    expect(saveSummaryItems).toHaveBeenCalledWith(
      "probe",
      [{ text: "Latest reinspection", photos: [] }],
      Q109,
    );
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it("failed unclicked legacy assignments block Submit and retry without losing the selections", async () => {
    vi.mocked(savePhotoAssignments).mockResolvedValue({
      success: false,
      error: "Assignment offline",
    });
    const photo = {
      url: "https://test/pool.jpg",
      filename: "pool.jpg",
      size: 1,
      uploadedAt: "2026-09-11",
    };
    const photoTemplate: FormTemplate = {
      ...template,
      fields: [
        ...template.fields,
        {
          id: "legacy_photo",
          label: "Legacy photo",
          type: "photo",
          required: false,
          order: 109,
        },
      ],
    };
    render(
      <Job formTemplate={photoTemplate} photos={[photo]} withAssignments />,
    );
    prepareSubmission();
    fireEvent.change(screen.getByLabelText("Assignment for pool.jpg"), {
      target: { value: "legacy_photo" },
    });
    submit();
    await settle();
    expect(submitJob).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Assignment for pool.jpg") as HTMLSelectElement)
        .value,
    ).toBe("legacy_photo");
    vi.mocked(savePhotoAssignments).mockResolvedValue({ success: true });
    submit();
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({ legacy_photo: photo.url }),
    );
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "Submit awaits remarks photo assignment (success: %s) and blocks unacknowledged failure",
    async (success) => {
      const assignment = deferred<{ success: boolean; error?: string }>();
      vi.mocked(assignRemarksFieldPhotos).mockImplementationOnce(
        () => assignment.promise,
      );
      const photo = {
        url: "https://test/remarks.jpg",
        filename: "remarks.jpg",
        size: 1,
        uploadedAt: "2026-09-11",
      };
      const remarksTemplate: FormTemplate = {
        ...template,
        fields: [
          ...template.fields,
          {
            id: "15_remarks_notes",
            label: "Remarks",
            type: "textarea",
            required: false,
            order: 109,
          },
        ],
      };
      render(<Job formTemplate={remarksTemplate} photos={[photo]} />);
      prepareSubmission();
      const remarks = within(
        screen.getByTestId("remarks-photos-15_remarks_notes"),
      );
      fireEvent.click(remarks.getByRole("button", { name: "Add" }));
      fireEvent.click(
        remarks.getByRole("button", {
          name: "Attach remarks.jpg to this remarks section",
        }),
      );
      submit();
      await settle();
      expect(saveFormData).not.toHaveBeenCalled();
      expect(submitJob).not.toHaveBeenCalled();
      assignment.resolve({
        success,
        error: success ? undefined : "Remarks offline",
      });
      await settle();
      if (!success) {
        expect(submitJob).not.toHaveBeenCalled();
        expect(toast.success).not.toHaveBeenCalled();
        fireEvent.click(
          screen.getByRole("button", { name: "Keep current photos" }),
        );
        submit();
        await settle();
      }
      expect(submitJob).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for a legacy photo upload before taking the latest form snapshot", async () => {
    const upload = deferred<Response>();
    const fetchUpload = vi.fn(() => upload.promise);
    vi.stubGlobal("fetch", fetchUpload);
    const photoTemplate: FormTemplate = {
      ...template,
      fields: [
        ...template.fields,
        {
          id: "legacy_photo",
          label: "Legacy photo",
          type: "photo",
          required: false,
          order: 109,
        },
      ],
    };
    render(<Job formTemplate={photoTemplate} />);
    prepareSubmission();
    fireEvent.change(screen.getByLabelText("Legacy photo"), {
      target: {
        files: [new File(["photo"], "Pool photo.jpg", { type: "image/jpeg" })],
      },
    });
    await settle();
    const body = (
      fetchUpload.mock.calls[0] as unknown as [string, RequestInit]
    )[1].body as globalThis.FormData;
    expect(body.get("jobId")).toBe("probe");
    expect(body.get("originalFilename")).toBe("Pool photo.jpg");
    submit();
    await settle();
    expect(saveFormData).not.toHaveBeenCalled();
    expect(submitJob).not.toHaveBeenCalled();
    upload.resolve({
      ok: true,
      json: async () => ({
        url: "https://test/uploaded.jpg",
        filename: "Pool photo.jpg",
        size: 5,
        uploadedAt: "2026-09-11",
      }),
    } as Response);
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({ legacy_photo: "https://test/uploaded.jpg" }),
    );
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it("blocks submission after a failed legacy photo until it is retried or dismissed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Upload offline");
      }),
    );
    const photoTemplate: FormTemplate = {
      ...template,
      fields: [
        ...template.fields,
        {
          id: "legacy_photo",
          label: "Legacy photo",
          type: "photo",
          required: false,
          order: 109,
        },
      ],
    };
    render(<Job formTemplate={photoTemplate} />);
    prepareSubmission();
    fireEvent.change(screen.getByLabelText("Legacy photo"), {
      target: {
        files: [new File(["photo"], "Pool photo.jpg", { type: "image/jpeg" })],
      },
    });
    await settle();
    submit();
    await settle();
    expect(submitJob).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue without this photo" }),
    );
    submit();
    await settle();
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it("Save drains an older form write, then saves the latest form and both independent summaries", async () => {
    const oldForm = deferred<void>();
    const original = deferred<{ success: boolean }>();
    const reinspection = deferred<{ success: boolean }>();
    vi.mocked(saveFormData).mockImplementationOnce(() => oldForm.promise);
    vi.mocked(saveSummaryItems).mockImplementation((_jobId, _items, fieldId) =>
      fieldId === Q107 ? original.promise : reinspection.promise,
    );
    render(<Job />);
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Older form write" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(saveFormData).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Latest notes" },
    });
    edit("Latest original", "107. Summary");
    edit("Latest reinspection");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saveSummaryItems).toHaveBeenCalledTimes(2);
    expect(saveFormData).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "Notes" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    oldForm.resolve();
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({ notes: "Latest notes" }),
    );
    original.resolve({ success: true });
    await settle();
    expect(toast.success).not.toHaveBeenCalled();
    reinspection.resolve({ success: true });
    await settle();
    expect(toast.success).toHaveBeenCalledWith("Saved");
    expect(saveSummaryItems).toHaveBeenCalledWith(
      "probe",
      [{ text: "Latest original", photos: [] }],
      Q107,
    );
    expect(saveSummaryItems).toHaveBeenCalledWith(
      "probe",
      [{ text: "Latest reinspection", photos: [] }],
      Q109,
    );
  });

  it("Submit waits for the newest summary snapshot queued behind an in-flight save", async () => {
    const older = deferred<{ success: boolean }>();
    const newer = deferred<{ success: boolean }>();
    vi.mocked(saveSummaryItems)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    render(<Job />);
    prepareSubmission();
    edit("Older in-flight snapshot", label109, true);
    await settle();
    edit("Newest queued reinspection", label109, true);
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Latest ordinary notes" },
    });
    submit();
    await settle();
    expect(submitJob).not.toHaveBeenCalled();
    expect(saveSummaryItems).toHaveBeenCalledTimes(1);
    older.resolve({ success: true });
    await settle();
    expect(saveSummaryItems).toHaveBeenLastCalledWith(
      "probe",
      [{ text: "Newest queued reinspection", photos: [] }],
      Q109,
    );
    expect(submitJob).not.toHaveBeenCalled();
    newer.resolve({ success: true });
    await settle();
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({ notes: "Latest ordinary notes" }),
    );
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it.each(["summary", "form"] as const)(
    "a failed %s save blocks Submit and remains retryable",
    async (writer) => {
      render(<Job />);
      prepareSubmission();
      if (writer === "summary") {
        vi.mocked(saveSummaryItems).mockResolvedValue({
          success: false,
          error: "Summary offline",
        });
        edit("Unsaved reinspection");
      } else {
        vi.mocked(saveFormData).mockRejectedValue(new Error("Form offline"));
      }
      submit();
      await settle();
      expect(submitJob).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.getByText(/offline/)).toBeTruthy();
      vi.mocked(saveSummaryItems).mockResolvedValue({ success: true });
      vi.mocked(saveFormData).mockResolvedValue(undefined);
      submit();
      await settle();
      expect(submitJob).toHaveBeenCalledTimes(1);
    },
  );

  it("global Save retries a failed summary and never reports success while it fails", async () => {
    vi.mocked(saveSummaryItems).mockResolvedValue({
      success: false,
      error: "Summary offline",
    });
    render(<Job />);
    edit("Keep these notes", label109, true);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saveSummaryItems).toHaveBeenCalledTimes(2);
    expect(toast.success).not.toHaveBeenCalled();
    expect(loadSummaryDraft("probe", Q109)).toEqual([
      { text: "Keep these notes", photos: [] },
    ]);
    vi.mocked(saveSummaryItems).mockResolvedValue({ success: true });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saveSummaryItems).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledWith("Saved");
    expect(loadSummaryDraft("probe", Q109)).toBeNull();
  });

  it("a photo deletion refresh removes only its URLs and preserves unsaved text in both sections", async () => {
    const photos = ["original", "deleted"].map((name) => ({
      url: `https://test/${name}.jpg`,
      filename: `${name}.jpg`,
      size: 1,
      uploadedAt: "2026-09-11",
    }));
    const data = {
      ...initialData,
      [K107]: [{ text: "Original findings", photos: [photos[0].url] }],
      [K109]: [{ text: "Prior reinspection", photos: [photos[1].url] }],
    };
    const view = render(<Job data={data} photos={photos} />);
    edit("Unsaved original text", "107. Summary");
    edit("Unsaved reinspection text");
    view.rerender(
      <Job
        data={{ ...data, [K109]: [{ text: "Prior reinspection", photos: [] }] }}
        photos={[photos[0]]}
      />,
    );
    await settle();
    expect(
      section().getByDisplayValue("Unsaved reinspection text"),
    ).toBeTruthy();
    expect(section().queryByRole("img")).toBeNull();
    expect(
      section("107. Summary").getByDisplayValue("Unsaved original text"),
    ).toBeTruthy();
    expect(section("107. Summary").getByRole("img").getAttribute("src")).toBe(
      photos[0].url,
    );
    expect(saveSummaryItems).toHaveBeenLastCalledWith(
      "probe",
      [{ text: "Unsaved reinspection text", photos: [] }],
      Q109,
    );
  });

  it("restores and resaves both summaries and normal fields after unmount before debounce/blur", async () => {
    const view = render(<Job />);
    edit("Recover original", "107. Summary");
    edit("Recover reinspection");
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Recover normal fields" },
    });
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(saveSummaryItems).not.toHaveBeenCalled();
    expect(saveFormData).not.toHaveBeenCalled();
    render(<Job />);
    expect(section().getByDisplayValue("Recover reinspection")).toBeTruthy();
    expect(
      section("107. Summary").getByDisplayValue("Recover original"),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Recover normal fields")).toBeTruthy();
    await settle();
    expect(saveSummaryItems).toHaveBeenCalledWith(
      "probe",
      [{ text: "Recover original", photos: [] }],
      Q107,
    );
    expect(saveSummaryItems).toHaveBeenCalledWith(
      "probe",
      [{ text: "Recover reinspection", photos: [] }],
      Q109,
    );
    expect(saveFormData).toHaveBeenLastCalledWith(
      "probe",
      expect.objectContaining({ notes: "Recover normal fields" }),
    );
    expect(localStorage.getItem("form-draft-probe")).toBeNull();
  });

  it("an ordinary autosave cannot erase an unsaved summary draft", async () => {
    vi.mocked(saveSummaryItems).mockResolvedValue({
      success: false,
      error: "Summary offline",
    });
    render(<Job />);
    edit("Summary draft", label109, true);
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), {
      target: { value: "Normal draft" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(loadFormDraft("probe")).toBeNull();
    expect(loadSummaryDraft("probe", Q109)).toEqual([
      { text: "Summary draft", photos: [] },
    ]);
  });

  it("submitted mode ignores local summary drafts and makes no recovery writes", async () => {
    const draft = render(<Job />);
    edit("Local unfinished text");
    draft.unmount();
    render(<Job disabled />);
    expect(section().getByDisplayValue("Prior reinspection")).toBeTruthy();
    expect(
      (section().getByRole("textbox") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await settle();
    expect(saveSummaryItems).not.toHaveBeenCalled();
  });

  it("keeps the 1s debounce and 5s continuous-typing flush", async () => {
    render(<Job />);
    edit("Debounced");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(saveSummaryItems).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(saveSummaryItems).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 6; n++) {
      if (n)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(900);
        });
      edit(`Continuous ${n}`);
    }
    expect(saveSummaryItems).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(saveSummaryItems).toHaveBeenLastCalledWith(
      "probe",
      [{ text: "Continuous 5", photos: [] }],
      Q109,
    );
  });
});
