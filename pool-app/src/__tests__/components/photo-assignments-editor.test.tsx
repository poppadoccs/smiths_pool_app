import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/actions/photo-assignments", () => ({
  savePhotoAssignments: vi.fn(async () => ({ success: true })),
}));

import { PhotoAssignmentsEditor } from "@/components/photo-assignments";
import type { FormField, FormTemplate } from "@/lib/forms";

function field(
  id: string,
  type: FormField["type"],
  order: number,
  label = id,
): FormField {
  return { id, label, type, required: false, order };
}

function photo(url: string) {
  return {
    url,
    filename: url.split("/").pop() ?? url,
    size: 100,
    uploadedAt: "2026-04-20",
  };
}

// Template covering every interesting field class:
//   - a true legacy single-slot photo (pool_hero_photo)
//   - every multi-photo map-backed owner (Q5/Q16/Q25/Q40/Q71)
//   - Q108
//   - a remarks textarea (should never be offered — it's not type=photo)
const TEMPLATE: FormTemplate = {
  id: "t1",
  name: "T",
  version: 1,
  fields: [
    field("pool_hero_photo", "photo", 1, "Pool hero photo"),
    field("5_picture_of_pool_and_spa_if_applicable", "photo", 2, "Q5"),
    field("16_photo_of_pool_pump", "photo", 3, "Q16"),
    field("25_picture_of_cartridge", "photo", 4, "Q25"),
    field("40_picture_if_leak_is_present_at_chlorinator", "photo", 5, "Q40"),
    field("71_picture_of_leaks_on_valves_if_applicable", "photo", 6, "Q71"),
    field("108_additional_photos", "photo", 7, "Q108"),
    field("15_remarks_notes", "textarea", 8, "Remarks 15"),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PhotoAssignmentsEditor — legacy-only target filter", () => {
  it("offers the legacy single-slot photo field as a selectable target", () => {
    render(
      <PhotoAssignmentsEditor
        jobId="j1"
        photos={[photo("http://test/p1")]}
        template={TEMPLATE}
        initialFormData={null}
      />,
    );
    const select = screen.getByLabelText(
      "Assignment for p1",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("pool_hero_photo");
  });

  it("does NOT offer any multi-photo map-backed owner as a target", () => {
    render(
      <PhotoAssignmentsEditor
        jobId="j1"
        photos={[photo("http://test/p1")]}
        template={TEMPLATE}
        initialFormData={null}
      />,
    );
    const select = screen.getByLabelText(
      "Assignment for p1",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    for (const id of [
      "5_picture_of_pool_and_spa_if_applicable",
      "16_photo_of_pool_pump",
      "25_picture_of_cartridge",
      "40_picture_if_leak_is_present_at_chlorinator",
      "71_picture_of_leaks_on_valves_if_applicable",
    ]) {
      expect(values).not.toContain(id);
    }
  });

  it("does NOT offer Q108 as a target", () => {
    render(
      <PhotoAssignmentsEditor
        jobId="j1"
        photos={[photo("http://test/p1")]}
        template={TEMPLATE}
        initialFormData={null}
      />,
    );
    const select = screen.getByLabelText(
      "Assignment for p1",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain("108_additional_photos");
  });

  it("does NOT offer remarks textarea ids (wrong type — defensive)", () => {
    render(
      <PhotoAssignmentsEditor
        jobId="j1"
        photos={[photo("http://test/p1")]}
        template={TEMPLATE}
        initialFormData={null}
      />,
    );
    const select = screen.getByLabelText(
      "Assignment for p1",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain("15_remarks_notes");
  });

  it("still offers Unassigned as the default", () => {
    render(
      <PhotoAssignmentsEditor
        jobId="j1"
        photos={[photo("http://test/p1")]}
        template={TEMPLATE}
        initialFormData={null}
      />,
    );
    const select = screen.getByLabelText(
      "Assignment for p1",
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain("UNASSIGNED");
    expect(select.value).toBe("UNASSIGNED");
  });
});
