import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render as renderView,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { useState, type ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/actions/photos", () => ({
  deletePhoto: vi.fn(async () => undefined),
  setPhotoIncludedInPdf: vi.fn(async () => undefined),
}));

// PhotoLightbox renders a portal/dialog; stub it so the tile-level UI
// tests stay focused on toggle/delete behavior and don't pull in lightbox
// rendering noise.
vi.mock("@/components/photo-lightbox", () => ({
  PhotoLightbox: () => null,
}));

import { PhotoGallery } from "@/components/photo-gallery";
import { deletePhoto, setPhotoIncludedInPdf } from "@/lib/actions/photos";
import { toast } from "sonner";
import type { PhotoMetadata } from "@/lib/photos";
import {
  JobSaveProvider,
  useJobSaveHandler,
  useJobSaves,
} from "@/components/job-save-provider";

const saveForm = vi.fn(async () => undefined);
function SaveControls() {
  useJobSaveHandler("form", saveForm);
  const { saveAll } = useJobSaves();
  const [status, setStatus] = useState("");
  return (
    <>
      <button
        onClick={() => {
          setStatus("Saving");
          void saveAll().then(
            () => setStatus("Saved"),
            () => setStatus("Save failed"),
          );
        }}
      >
        Save all
      </button>
      <output>{status}</output>
    </>
  );
}
function render(element: ReactElement) {
  return renderView(
    <JobSaveProvider>
      <SaveControls />
      {element}
    </JobSaveProvider>,
  );
}

function photo(
  overrides: Partial<PhotoMetadata> & Pick<PhotoMetadata, "url">,
): PhotoMetadata {
  return {
    filename: overrides.url.split("/").pop() ?? overrides.url,
    size: 100,
    uploadedAt: "2026-04-28T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PhotoGallery — empty + base render", () => {
  it("reports incomplete Blob cleanup without claiming the file was deleted", async () => {
    vi.mocked(deletePhoto).mockResolvedValueOnce({
      success: true,
      blobCleanupPending: true,
    });
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/cleanup" })]}
        jobId="job-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Photo removed from the job; stored file cleanup could not finish.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("renders empty-state copy when there are no photos", () => {
    render(<PhotoGallery photos={[]} jobId="job-1" />);
    expect(screen.getByText(/No photos yet/i)).toBeTruthy();
  });

  it("renders one tile per photo with stable test ids", () => {
    render(
      <PhotoGallery
        photos={[
          photo({ url: "http://test/a" }),
          photo({ url: "http://test/b" }),
        ]}
        jobId="job-1"
      />,
    );
    expect(screen.getByTestId("photo-tile-http://test/a")).toBeTruthy();
    expect(screen.getByTestId("photo-tile-http://test/b")).toBeTruthy();
  });
});

describe("PhotoGallery — PDF include/exclude toggle", () => {
  it("legacy photos (includedInPdf undefined) render as included — no badge, full opacity, toggle aria-label says 'Exclude'", () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/legacy" })]}
        jobId="job-1"
      />,
    );
    const tile = screen.getByTestId("photo-tile-http://test/legacy");
    expect(tile.getAttribute("data-included-in-pdf")).toBe("true");
    expect(
      screen.queryByTestId("excluded-badge-http://test/legacy"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Exclude legacy from PDF/i }),
    ).toBeTruthy();
  });

  it("photo with includedInPdf=true renders identically to a legacy photo", () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/in", includedInPdf: true })]}
        jobId="job-1"
      />,
    );
    const tile = screen.getByTestId("photo-tile-http://test/in");
    expect(tile.getAttribute("data-included-in-pdf")).toBe("true");
    expect(screen.queryByTestId("excluded-badge-http://test/in")).toBeNull();
  });

  it("photo with includedInPdf=false renders excluded — 'Not in PDF' badge present, toggle aria-label says 'Include'", () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/out", includedInPdf: false })]}
        jobId="job-1"
      />,
    );
    const tile = screen.getByTestId("photo-tile-http://test/out");
    expect(tile.getAttribute("data-included-in-pdf")).toBe("false");
    expect(screen.getByTestId("excluded-badge-http://test/out")).toBeTruthy();
    expect(screen.getByText(/Not in PDF/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Include out in PDF/i }),
    ).toBeTruthy();
  });

  it("clicking the toggle on an included photo invokes setPhotoIncludedInPdf with included=false (the inversion of current state)", async () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/p", includedInPdf: true })]}
        jobId="job-9"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Exclude p from PDF/i }),
    );
    await waitFor(() => expect(setPhotoIncludedInPdf).toHaveBeenCalledTimes(1));
    expect(setPhotoIncludedInPdf).toHaveBeenCalledWith(
      "job-9",
      "http://test/p",
      false,
    );
  });

  it("clicking the toggle on an excluded photo invokes setPhotoIncludedInPdf with included=true", async () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/p", includedInPdf: false })]}
        jobId="job-9"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Include p in PDF/i }));
    await waitFor(() => expect(setPhotoIncludedInPdf).toHaveBeenCalledTimes(1));
    expect(setPhotoIncludedInPdf).toHaveBeenCalledWith(
      "job-9",
      "http://test/p",
      true,
    );
  });

  it("submitted-style state (readOnly=true + allowPdfInclusionToggle=false) hides BOTH toggle and delete; excluded badge stays visible (informational)", () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/p", includedInPdf: false })]}
        jobId="job-1"
        readOnly
        allowPdfInclusionToggle={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Include p in PDF/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/i })).toBeNull();
    // Badge still shows so the office can see the exclusion state on
    // submitted jobs (read-only state).
    expect(screen.getByTestId("excluded-badge-http://test/p")).toBeTruthy();
  });

  it("default behavior preserved: readOnly=true with no allowPdfInclusionToggle prop hides BOTH (back-compat for any caller that hasn't opted in to the split)", () => {
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/p", includedInPdf: false })]}
        jobId="job-1"
        readOnly
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Include p in PDF/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/i })).toBeNull();
    expect(screen.getByTestId("excluded-badge-http://test/p")).toBeTruthy();
  });

  // ── Editable-copy permission split (the regression Codex flagged) ────────
  // Editable copies share blob URLs with the SUBMITTED source, so delete is
  // gated (clicking it would del() the shared blob and corrupt the source).
  // But the include/exclude flag lives on the COPY's own job.photos JSON —
  // toggling it can't affect the source. So delete must stay hidden while
  // the toggle stays visible. That's exactly the readOnly=true +
  // allowPdfInclusionToggle=true combination page.tsx now passes.
  describe("PhotoGallery — editable-copy permission split", () => {
    it("editable-copy state (readOnly=true + allowPdfInclusionToggle=true): include/exclude toggle visible, delete HIDDEN, excluded badge visible", () => {
      render(
        <PhotoGallery
          photos={[photo({ url: "http://test/p", includedInPdf: false })]}
          jobId="copy-1"
          readOnly
          allowPdfInclusionToggle
        />,
      );
      expect(
        screen.getByRole("button", { name: /Include p in PDF/i }),
      ).toBeTruthy();
      // Critical: destructive delete must NOT be exposed on a copy — that's
      // the whole reason readOnly is still true.
      expect(
        screen.queryByRole("button", { name: /Delete photo/i }),
      ).toBeNull();
      expect(screen.getByTestId("excluded-badge-http://test/p")).toBeTruthy();
    });

    it("editable-copy toggle still invokes setPhotoIncludedInPdf with inverted state (the action ALLOWS toggling on copies — see photos.test.ts ALLOWS-on-copy test)", async () => {
      render(
        <PhotoGallery
          photos={[photo({ url: "http://test/shared", includedInPdf: true })]}
          jobId="copy-9"
          readOnly
          allowPdfInclusionToggle
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Exclude shared from PDF/i }),
      );
      await waitFor(() =>
        expect(setPhotoIncludedInPdf).toHaveBeenCalledTimes(1),
      );
      expect(setPhotoIncludedInPdf).toHaveBeenCalledWith(
        "copy-9",
        "http://test/shared",
        false,
      );
      // Delete action must not have been called.
      expect(deletePhoto).not.toHaveBeenCalled();
    });

    it("explicit allowPdfInclusionToggle={false} on a draft (readOnly=false) hides ONLY the toggle, leaves delete intact (prop wins over !readOnly default)", () => {
      render(
        <PhotoGallery
          photos={[photo({ url: "http://test/d", includedInPdf: true })]}
          jobId="job-1"
          allowPdfInclusionToggle={false}
        />,
      );
      expect(
        screen.queryByRole("button", { name: /Exclude d from PDF/i }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: /Delete photo/i }),
      ).toBeTruthy();
    });
  });
});

describe("PhotoGallery — delete still works alongside the new toggle", () => {
  it("global save waits for deletion and disables further photo changes", async () => {
    let finish!: (value: {
      success: true;
      blobCleanupPending: boolean;
    }) => void;
    vi.mocked(deletePhoto).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/pending" })]}
        jobId="job-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(deletePhoto).toHaveBeenCalled());
    expect(saveForm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Exclude pending/ }),
    ).toBeDisabled();
    await act(async () => finish({ success: true, blobCleanupPending: false }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    expect(saveForm).toHaveBeenCalledTimes(1);
  });

  it("failed photo changes block save until retried or explicitly dismissed", async () => {
    vi.mocked(setPhotoIncludedInPdf).mockRejectedValueOnce(
      new Error("offline"),
    );
    render(
      <PhotoGallery
        photos={[photo({ url: "http://test/failed" })]}
        jobId="job-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Exclude failed/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() =>
      expect(screen.getByText("Save failed")).toBeInTheDocument(),
    );
    expect(saveForm).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss failed photo change" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("delete button on an included photo still calls deletePhoto (no regression from adding the new toggle)", async () => {
    render(
      <PhotoGallery photos={[photo({ url: "http://test/d" })]} jobId="job-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete photo/i }));
    await waitFor(() => expect(deletePhoto).toHaveBeenCalledTimes(1));
    expect(deletePhoto).toHaveBeenCalledWith("job-1", "http://test/d");
    // Toggle action must NOT have been called by the delete click.
    expect(setPhotoIncludedInPdf).not.toHaveBeenCalled();
  });
});
