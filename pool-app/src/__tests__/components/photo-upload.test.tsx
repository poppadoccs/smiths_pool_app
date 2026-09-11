import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("browser-image-compression", () => ({ default: vi.fn() }));

import imageCompression from "browser-image-compression";
import { PhotoUpload } from "@/components/photo-upload";
import {
  JobSaveProvider,
  useJobSaveHandler,
  useJobSaves,
} from "@/components/job-save-provider";

const saveForm = vi.fn(async () => undefined);
const submit = vi.fn<() => Promise<void>>(async () => undefined);
const submitError = vi.fn();

function SubmitProbe() {
  const saves = useJobSaves();
  useJobSaveHandler("form", saveForm);
  return (
    <button onClick={() => void saves.runAfterSave(submit).catch(submitError)}>
      Submit probe
    </button>
  );
}

function renderUpload() {
  return render(
    <JobSaveProvider>
      <PhotoUpload jobId="draft-job" />
      <SubmitProbe />
    </JobSaveProvider>,
  );
}

function uploaded() {
  return {
    ok: true,
    json: async () => ({
      url: "https://test/uploaded.jpg",
      size: 4,
      filename: "photo.jpg",
      uploadedAt: "2026-09-11",
    }),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue(undefined);
  vi.mocked(imageCompression).mockImplementation(async (file) => file);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => uploaded()),
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PhotoUpload registration and submission coordination", () => {
  it("sends the destination and display filename with the compressed file", async () => {
    const compressed = new File(["jpeg"], "compressed.jpg", {
      type: "image/jpeg",
    });
    vi.mocked(imageCompression).mockResolvedValue(compressed);
    const { container } = renderUpload();
    fireEvent.change(container.querySelector("input[multiple]")!, {
      target: {
        files: [
          new File(["uncompressed photo"], "Pool view (1).jpg", {
            type: "image/jpeg",
          }),
        ],
      },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    const body = options!.body as FormData;
    expect(url).toBe("/api/photos/upload");
    expect(body.get("jobId")).toBe("draft-job");
    expect(body.get("originalFilename")).toBe("Pool view (1).jpg");
    expect((body.get("file") as File).size).toBe(4);
    expect(body.has("url")).toBe(false);
    expect(body.has("size")).toBe(false);
    fireEvent.click(screen.getByText("Submit probe"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

  it("waits for every file in the selected batch before saving or submitting", async () => {
    const completions: Array<(value: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => completions.push(resolve)),
    );
    const { container } = renderUpload();
    fireEvent.change(container.querySelector("input[multiple]")!, {
      target: {
        files: [
          new File(["first"], "first.jpg", { type: "image/jpeg" }),
          new File(["second"], "second.jpg", { type: "image/jpeg" }),
        ],
      },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Submit probe"));
    expect(saveForm).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "From Library",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => completions[0](uploaded()));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(saveForm).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => completions[1](uploaded()));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(saveForm).toHaveBeenCalledTimes(1);
  });

  it("blocks submission after registration fails until the failed upload is removed", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Could not register photo" }),
    } as Response);
    const { container } = renderUpload();
    fireEvent.change(container.querySelector("input[multiple]")!, {
      target: {
        files: [new File(["jpeg"], "failed.jpg", { type: "image/jpeg" })],
      },
    });
    await waitFor(() =>
      expect(screen.getByText("Could not register photo")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Submit probe"));
    await waitFor(() => expect(submitError).toHaveBeenCalledTimes(1));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove failed upload failed.jpg" }),
    );
    fireEvent.click(screen.getByText("Submit probe"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

  it("allows a successful retry of the same file after compression fails", async () => {
    vi.mocked(imageCompression).mockRejectedValueOnce(
      new Error("Compression failed"),
    );
    const { container } = renderUpload();
    const file = new File(["jpeg"], "retry.jpg", { type: "image/jpeg" });
    const input = container.querySelector("input[multiple]")!;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByText("Compression failed")).toBeTruthy(),
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Submit probe"));
    await waitFor(() => expect(submitError).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Submit probe"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Compression failed")).toBeNull();
  });

  it("does not start a new upload while submission holds the job lock", async () => {
    let finishSubmit!: () => void;
    submit.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSubmit = resolve;
        }),
    );
    const { container } = renderUpload();
    fireEvent.click(screen.getByText("Submit probe"));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole("button", { name: "Take Photo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(container.querySelector("input[multiple]")!, {
      target: {
        files: [new File(["jpeg"], "too-late.jpg", { type: "image/jpeg" })],
      },
    });
    expect(imageCompression).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => finishSubmit());
  });
});
