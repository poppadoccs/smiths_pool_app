import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";

// --- Mocks for client-side dependencies ---
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/actions/photo-assignments", () => ({
  assignRemarksFieldPhotos: vi.fn(async () => ({ success: true })),
}));

import { RemarksPhotosField } from "@/components/remarks-photos-field";
import { assignRemarksFieldPhotos } from "@/lib/actions/photo-assignments";
import { RESERVED_PHOTO_MAP_KEY } from "@/lib/multi-photo";

function photoMeta(url: string) {
  return {
    url,
    filename: url.split("/").pop() ?? url,
    size: 100,
    uploadedAt: "2026-04-20",
  };
}

const REMARKS_15 = "15_remarks_notes";
const REMARKS_15_PHOTOS = "15_remarks_notes_photos";
const REMARKS_33 = "33_remarks_notes";
const REMARKS_33_PHOTOS = "33_remarks_notes_photos";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RemarksPhotosField", () => {
  it("renders companion UI for a remarks textarea id with the correct owner-id marker", () => {
    const { getByTestId } = render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[photoMeta("http://test/a"), photoMeta("http://test/b")]}
        formData={null}
      />,
    );

    const container = getByTestId(`remarks-photos-${REMARKS_15}`);
    expect(container).toBeTruthy();
    // data-owner-id is the synthetic *_photos id derived via the helper,
    // NEVER the textarea id. This is the structural proof that the UI
    // routes through remarksPhotoOwnerIdFor.
    expect(container.getAttribute("data-owner-id")).toBe(REMARKS_15_PHOTOS);
  });

  it("displays assigned photos from the *_photos bucket (not from the textarea key)", () => {
    const { container } = render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[
          photoMeta("http://test/photo-a"),
          photoMeta("http://test/photo-b"),
        ]}
        formData={{
          // Textarea holds note text — if this ever leaked into the photo
          // reader, a rendered <img> with src="note text" would appear.
          [REMARKS_15]: "a note about the pump",
          [RESERVED_PHOTO_MAP_KEY]: {
            [REMARKS_15_PHOTOS]: ["http://test/photo-a", "http://test/photo-b"],
          },
        }}
      />,
    );

    const imgs = container.querySelectorAll("img");
    const srcs = Array.from(imgs).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["http://test/photo-a", "http://test/photo-b"]);
    // The textarea note string never appears as an <img> src.
    expect(srcs).not.toContain("a note about the pump");
  });

  it("count reflects current URLs and REMARKS_PHOTO_CAP=8", () => {
    render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[photoMeta("http://test/a")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: {
            [REMARKS_15_PHOTOS]: ["http://test/a"],
          },
        }}
      />,
    );

    expect(
      screen.getByTestId(`remarks-photos-count-${REMARKS_15}`).textContent,
    ).toBe("(1 of 8)");
  });

  it("clicking a photo in the picker calls assignRemarksFieldPhotos with the synthetic owner id (not the textarea id)", async () => {
    render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[photoMeta("http://test/candidate")]}
        formData={null}
      />,
    );

    // Open picker.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // Click the candidate photo tile.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Attach candidate to this remarks section",
      }),
    );

    await waitFor(() => {
      expect(assignRemarksFieldPhotos).toHaveBeenCalledTimes(1);
    });
    const [jobId, ownerId, urls] = vi.mocked(assignRemarksFieldPhotos).mock
      .calls[0];
    expect(jobId).toBe("job-1");
    // Crucial: ownerId is the synthetic *_photos id, not the textarea id.
    expect(ownerId).toBe(REMARKS_15_PHOTOS);
    expect(ownerId).not.toBe(REMARKS_15);
    expect(urls).toEqual(["http://test/candidate"]);
  });

  it("clicking the remove button on an assigned thumbnail calls the action with the URL filtered out", async () => {
    render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[
          photoMeta("http://test/keep"),
          photoMeta("http://test/drop"),
        ]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: {
            [REMARKS_15_PHOTOS]: ["http://test/keep", "http://test/drop"],
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove drop from remarks" }),
    );

    await waitFor(() => {
      expect(assignRemarksFieldPhotos).toHaveBeenCalledTimes(1);
    });
    const [, ownerId, urls] = vi.mocked(assignRemarksFieldPhotos).mock.calls[0];
    expect(ownerId).toBe(REMARKS_15_PHOTOS);
    expect(urls).toEqual(["http://test/keep"]);
  });

  it("sibling isolation: two remarks fields each display only their own bucket", () => {
    const formData = {
      [RESERVED_PHOTO_MAP_KEY]: {
        [REMARKS_15_PHOTOS]: ["http://test/fifteen"],
        [REMARKS_33_PHOTOS]: ["http://test/thirtythree"],
      },
    };
    const jobPhotos = [
      photoMeta("http://test/fifteen"),
      photoMeta("http://test/thirtythree"),
    ];

    const { container: c15 } = render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={jobPhotos}
        formData={formData}
      />,
    );
    const { container: c33 } = render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_33}
        jobPhotos={jobPhotos}
        formData={formData}
      />,
    );

    const srcs15 = Array.from(c15.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );
    const srcs33 = Array.from(c33.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );

    expect(srcs15).toEqual(["http://test/fifteen"]);
    expect(srcs33).toEqual(["http://test/thirtythree"]);
    expect(srcs15).not.toContain("http://test/thirtythree");
    expect(srcs33).not.toContain("http://test/fifteen");
  });

  it("returns null for a non-remarks textarea id (no companion UI leaks)", () => {
    const { container } = render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId="customer_notes" // arbitrary non-remarks textarea
        jobPhotos={[photoMeta("http://test/a")]}
        formData={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("at-cap state: Add picker buttons disabled and count shows 8 of 8", async () => {
    const eightUrls = Array.from({ length: 8 }, (_, i) => `http://test/p${i}`);
    render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[
          ...eightUrls.map(photoMeta),
          photoMeta("http://test/ninth-candidate"),
        ]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: { [REMARKS_15_PHOTOS]: eightUrls },
        }}
      />,
    );

    // Count reflects the 8/8 state.
    expect(
      screen.getByTestId(`remarks-photos-count-${REMARKS_15}`).textContent,
    ).toBe("(8 of 8)");

    // Open the picker to reveal the 9th candidate photo tile.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const candidateBtn = screen.getByRole("button", {
      name: "Attach ninth-candidate to this remarks section",
    }) as HTMLButtonElement;
    // Using the plain DOM property instead of jest-dom's toBeDisabled so
    // this test file doesn't need a jest-dom setup entry for a single
    // assertion.
    expect(candidateBtn.disabled).toBe(true);

    // Click anyway — the action must NOT fire when the UI is at cap.
    fireEvent.click(candidateBtn);
    // Give any transitional update a chance.
    await waitFor(() => {});
    expect(assignRemarksFieldPhotos).not.toHaveBeenCalled();
  });

  // ── Race-guard test (v1.1) ────────────────────────────────────────────────
  // See multi-photo-field.test.tsx for the rationale. Fires two synchronous
  // .click() calls inside the same render closure. The previous v1 fix that
  // checked render-state `isPending` could not block this because both
  // handler invocations read the same stale `false`. v1.1 uses a synchronous
  // ref so the second handler sees `true` instantly.
  it("rapid double add fires only ONE assignRemarksFieldPhotos — second click is locked out", async () => {
    let resolveFirst!: (val: { success: true }) => void;
    vi.mocked(assignRemarksFieldPhotos).mockImplementation(
      () =>
        new Promise<{ success: true }>((res) => {
          resolveFirst = res;
        }),
    );

    render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[photoMeta("http://test/x"), photoMeta("http://test/y")]}
        formData={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const cX = screen.getByRole("button", {
      name: "Attach x to this remarks section",
    }) as HTMLButtonElement;
    const cY = screen.getByRole("button", {
      name: "Attach y to this remarks section",
    }) as HTMLButtonElement;

    // Wrapped in a single act() — both clicks fire before React flushes,
    // preserving the same-tick race shape while suppressing the React
    // "not wrapped in act" warning.
    act(() => {
      cX.click();
      cY.click();
    });

    expect(assignRemarksFieldPhotos).toHaveBeenCalledTimes(1);
    const [, ownerId, urls] = vi.mocked(assignRemarksFieldPhotos).mock.calls[0];
    expect(ownerId).toBe(REMARKS_15_PHOTOS);
    expect(urls).toEqual(["http://test/x"]);

    resolveFirst({ success: true });
    await waitFor(() => {});
  });

  it("disabled prop hides the Add button AND remove buttons (read-only view)", () => {
    render(
      <RemarksPhotosField
        jobId="job-1"
        textareaFieldId={REMARKS_15}
        jobPhotos={[photoMeta("http://test/a")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: { [REMARKS_15_PHOTOS]: ["http://test/a"] },
        }}
        disabled
      />,
    );

    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();
  });
});
