import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/actions/photo-assignments", () => ({
  assignMultiFieldPhotos: vi.fn(async () => ({ success: true })),
  assignAdditionalPhotos: vi.fn(async () => ({ success: true })),
}));

// The component pulls savePhotoMetadata for the capture path, which
// transitively loads Prisma. Tests never exercise capture, but the
// import still runs — mock the whole module to keep it DB-free.
vi.mock("@/lib/actions/photos", () => ({
  savePhotoMetadata: vi.fn(async () => ({ success: true })),
}));

import { MultiPhotoField } from "@/components/multi-photo-field";
import {
  assignAdditionalPhotos,
  assignMultiFieldPhotos,
} from "@/lib/actions/photo-assignments";
import { RESERVED_PHOTO_MAP_KEY } from "@/lib/multi-photo";
import type { FormField } from "@/lib/forms";

function photo(url: string) {
  return {
    url,
    filename: url.split("/").pop() ?? url,
    size: 100,
    uploadedAt: "2026-04-20",
  };
}

function photoField(id: string, label = id): FormField {
  return { id, label, type: "photo", required: false, order: 1 };
}

const Q5_ID = "5_picture_of_pool_and_spa_if_applicable";
const Q16_ID = "16_photo_of_pool_pump";
const Q108_ID = "108_additional_photos";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MultiPhotoField", () => {
  it("renders companion UI for a multi-photo field with the correct owner marker", () => {
    const { getByTestId } = render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5 Pool & Spa")}
        jobPhotos={[photo("http://test/a")]}
        formData={null}
      />,
    );
    const container = getByTestId(`multi-photo-${Q5_ID}`);
    expect(container).toBeTruthy();
    expect(container.getAttribute("data-owner-id")).toBe(Q5_ID);
  });

  it("returns null for a non-map-backed photo field id (defensive)", () => {
    const { container } = render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField("pool_hero_photo")}
        jobPhotos={[photo("http://test/a")]}
        formData={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("displays assigned photos from the map bucket and count uses the Q5 cap of 5", () => {
    const { container } = render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[photo("http://test/a"), photo("http://test/b")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: {
            [Q5_ID]: ["http://test/a", "http://test/b"],
          },
        }}
      />,
    );
    const imgs = container.querySelectorAll("img");
    const srcs = Array.from(imgs).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["http://test/a", "http://test/b"]);
    expect(screen.getByTestId(`multi-photo-count-${Q5_ID}`).textContent).toBe(
      "(2 of 5)",
    );
  });

  it("Q108 uses the Q108 cap of 7 and routes writes through assignAdditionalPhotos", async () => {
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q108_ID, "Q108 Additional")}
        jobPhotos={[photo("http://test/gallery1")]}
        formData={null}
      />,
    );
    expect(screen.getByTestId(`multi-photo-count-${Q108_ID}`).textContent).toBe(
      "(0 of 7)",
    );

    // Open picker, click the one gallery photo.
    fireEvent.click(screen.getByRole("button", { name: /Add from gallery/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Attach gallery1 to Q108/i }),
    );

    await waitFor(() => {
      expect(assignAdditionalPhotos).toHaveBeenCalledTimes(1);
    });
    expect(assignMultiFieldPhotos).not.toHaveBeenCalled();
    const [jobId, urls] = vi.mocked(assignAdditionalPhotos).mock.calls[0];
    expect(jobId).toBe("job-1");
    expect(urls).toEqual(["http://test/gallery1"]);
  });

  it("gallery pick for Q5 calls assignMultiFieldPhotos with fieldId and appended urls", async () => {
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[photo("http://test/kept"), photo("http://test/new")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: { [Q5_ID]: ["http://test/kept"] },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add from gallery/i }));
    fireEvent.click(screen.getByRole("button", { name: /Attach new to Q5/i }));

    await waitFor(() => {
      expect(assignMultiFieldPhotos).toHaveBeenCalledTimes(1);
    });
    const [jobId, fieldId, urls] = vi.mocked(assignMultiFieldPhotos).mock
      .calls[0];
    expect(jobId).toBe("job-1");
    expect(fieldId).toBe(Q5_ID);
    expect(urls).toEqual(["http://test/kept", "http://test/new"]);
  });

  it("remove button filters the URL out and calls the action", async () => {
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[photo("http://test/keep"), photo("http://test/drop")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: {
            [Q5_ID]: ["http://test/keep", "http://test/drop"],
          },
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Remove drop from Q5/i }),
    );

    await waitFor(() => {
      expect(assignMultiFieldPhotos).toHaveBeenCalledTimes(1);
    });
    const [, , urls] = vi.mocked(assignMultiFieldPhotos).mock.calls[0];
    expect(urls).toEqual(["http://test/keep"]);
  });

  it("sibling isolation: Q5 assignments do not appear in Q16's companion", () => {
    const formData = {
      [RESERVED_PHOTO_MAP_KEY]: {
        [Q5_ID]: ["http://test/five"],
        [Q16_ID]: ["http://test/sixteen"],
      },
    };
    const jobPhotos = [photo("http://test/five"), photo("http://test/sixteen")];

    const { container: c5 } = render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={jobPhotos}
        formData={formData}
      />,
    );
    const { container: c16 } = render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q16_ID, "Q16")}
        jobPhotos={jobPhotos}
        formData={formData}
      />,
    );

    const srcs5 = Array.from(c5.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );
    const srcs16 = Array.from(c16.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );

    expect(srcs5).toEqual(["http://test/five"]);
    expect(srcs16).toEqual(["http://test/sixteen"]);
    expect(srcs5).not.toContain("http://test/sixteen");
    expect(srcs16).not.toContain("http://test/five");
  });

  it("at-cap: picker candidate tiles are disabled and action does not fire", async () => {
    // Q5 cap is 5. Pre-populate with 5 URLs and a 6th candidate in the pool.
    const fiveUrls = Array.from({ length: 5 }, (_, i) => `http://test/p${i}`);
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[...fiveUrls.map(photo), photo("http://test/sixth")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: { [Q5_ID]: fiveUrls },
        }}
      />,
    );

    expect(screen.getByTestId(`multi-photo-count-${Q5_ID}`).textContent).toBe(
      "(5 of 5)",
    );

    fireEvent.click(screen.getByRole("button", { name: /Add from gallery/i }));
    const candidate = screen.getByRole("button", {
      name: /Attach sixth to Q5/i,
    }) as HTMLButtonElement;
    expect(candidate.disabled).toBe(true);
    fireEvent.click(candidate);
    await waitFor(() => {});
    expect(assignMultiFieldPhotos).not.toHaveBeenCalled();
  });

  it("disabled prop hides Add-from-gallery, Take-photo, and Remove buttons", () => {
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[photo("http://test/a")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: { [Q5_ID]: ["http://test/a"] },
        }}
        disabled
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Add from gallery/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Take photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();
  });

  it("renders 'Add from gallery' in the empty state (jobPhotos=[]) alongside 'Take photo'", () => {
    // Regression: the button used to be gated on `jobPhotos.length > 0`,
    // so a fresh job with no uploads yet hid the gallery option entirely
    // and forced users to discover it by taking a photo first. Both
    // buttons should be visible in the empty state for every map-backed
    // owner that uses this component.
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[]}
        formData={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Add from gallery/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Take photo/i })).toBeTruthy();
  });

  it("renders 'Add from gallery' in the empty state for Q108 too", () => {
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q108_ID, "Q108")}
        jobPhotos={[]}
        formData={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Add from gallery/i }),
    ).toBeTruthy();
  });

  it("empty-state gallery picker tells the user what to do instead of 'all already attached'", () => {
    // Opening the picker with no uploads yet used to show the wrong
    // message ("all uploaded photos are already attached here") because
    // availableToAdd is also empty in that case. Differentiate the
    // two empty-state reasons so the user gets an accurate hint.
    render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[]}
        formData={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add from gallery/i }));
    expect(screen.getByText(/No photos uploaded yet/i)).toBeTruthy();
  });

  it("reopen/read path: assigned photos persist via __photoAssignmentsByField even with no legacy mirror", () => {
    // Simulates reopening a draft that was written ONLY via assignMultiFieldPhotos
    // (map entry present, legacy mirror also present per that action's write
    // contract). We still primarily read from the map, so the field's
    // thumbnails render from the map entry.
    const { container } = render(
      <MultiPhotoField
        jobId="job-1"
        field={photoField(Q5_ID, "Q5")}
        jobPhotos={[photo("http://test/persisted")]}
        formData={{
          [RESERVED_PHOTO_MAP_KEY]: { [Q5_ID]: ["http://test/persisted"] },
          // Legacy mirror also present — intentionally matches map[0].
          [Q5_ID]: "http://test/persisted",
        }}
      />,
    );
    const srcs = Array.from(container.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );
    expect(srcs).toEqual(["http://test/persisted"]);
  });
});
