import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(),
    },
    // saveFormData writes via $executeRaw for an atomic jsonb merge that
    // cannot be TOCTOU-clobbered by a concurrent dedicated-action write.
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { saveFormData } from "@/lib/actions/forms";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import {
  ADDITIONAL_PHOTOS_FIELD_ID,
  MULTI_PHOTO_FIELD_IDS,
  RESERVED_PHOTO_MAP_KEY,
  REVIEWED_FLAG,
  readFieldPhotoUrls,
} from "@/lib/multi-photo";
import { getDefaultValues, type FormTemplate } from "@/lib/forms";
import { RESERVED_SUMMARY_KEY } from "@/lib/summary";

const MULTI_FIELD = "5_picture_of_pool_and_spa_if_applicable";

// Helper: the JSON patch saveFormData sent as the first interpolated value
// in its tagged-template $executeRaw call. Mirrors what Postgres would
// shallow-merge into the existing form_data column at write time.
function writtenPatch(): Record<string, unknown> {
  const calls = vi.mocked(db.$executeRaw).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1] as unknown as [
    TemplateStringsArray,
    ...unknown[],
  ];
  const patchJson = lastCall[1] as string;
  return JSON.parse(patchJson);
}

// Helper: the static SQL pieces from the tagged template. Joining them
// (with a neutral separator) lets us grep for operators and guard clauses
// without depending on exact whitespace.
function writtenSqlStatic(): string {
  const calls = vi.mocked(db.$executeRaw).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1] as unknown as [
    string[],
    ...unknown[],
  ];
  return lastCall[0].join(" $ ");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.$executeRaw).mockResolvedValue(1 as never);
});

describe("saveFormData", () => {
  it("sends a non-reserved patch to the atomic jsonb merge", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
    } as never);

    const formData = { customer_name: "Alice", pool_type: "Inground" };
    await saveFormData("job-1", formData);

    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(writtenPatch()).toEqual(formData);
  });

  it("patch carries every non-reserved RHF key for DB-side merge", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { customer_name: "Old" },
    } as never);

    const formData = { customer_name: "New", address: "123 Main" };
    await saveFormData("job-1", formData);

    // Patch contains the RHF keys as-is; Postgres `||` merges them over
    // the existing form_data column server-side.
    expect(writtenPatch()).toEqual(formData);
  });

  it("revalidates the job path on success", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
    } as never);

    await saveFormData("job-1", { name: "Test" });

    expect(revalidatePath).toHaveBeenCalledWith("/jobs/job-1");
  });

  it("throws when job not found and issues no UPDATE", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(null);

    await expect(saveFormData("bad-id", {})).rejects.toThrow("Job not found");
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  // --- Reserved-key channel proofs ---

  it("patch omits __photoAssignmentsByField so the DB value survives the merge", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        customer_name: "X",
        [RESERVED_PHOTO_MAP_KEY]: { [MULTI_FIELD]: ["u1"] },
      },
    } as never);

    await saveFormData("job-1", { customer_name: "Y" });

    const patch = writtenPatch();
    expect(patch.customer_name).toBe("Y");
    expect(patch).not.toHaveProperty(RESERVED_PHOTO_MAP_KEY);
  });

  it("patch omits __summary_items so the DB value survives the merge", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        foo: "a",
        [RESERVED_SUMMARY_KEY]: [{ text: "t", photos: [] }],
      },
    } as never);

    await saveFormData("job-1", { foo: "b" });

    const patch = writtenPatch();
    expect(patch.foo).toBe("b");
    expect(patch).not.toHaveProperty(RESERVED_SUMMARY_KEY);
  });

  it("patch omits __photoAssignmentsReviewed so the DB value survives the merge", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { foo: "a", [REVIEWED_FLAG]: true },
    } as never);

    await saveFormData("job-1", { foo: "b" });

    const patch = writtenPatch();
    expect(patch.foo).toBe("b");
    expect(patch).not.toHaveProperty(REVIEWED_FLAG);
  });

  it("filters undefined RHF values from the patch (no accidental DB deletes)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { foo: "keep_me" },
    } as never);

    await saveFormData("job-1", { foo: undefined } as never);

    // Key with undefined value is not in the patch at all. The DB value
    // stays untouched under `||` merge.
    expect(writtenPatch()).not.toHaveProperty("foo");
  });

  it("strips __-prefixed keys from the client payload", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        foo: "a",
        [RESERVED_PHOTO_MAP_KEY]: { [MULTI_FIELD]: ["good"] },
      },
    } as never);

    await saveFormData("job-1", {
      foo: "b",
      [RESERVED_PHOTO_MAP_KEY]: { [MULTI_FIELD]: ["EVIL_CLIENT_OVERWRITE"] },
    } as never);

    const patch = writtenPatch();
    expect(patch.foo).toBe("b");
    expect(patch).not.toHaveProperty(RESERVED_PHOTO_MAP_KEY);
  });

  it.each([...MULTI_PHOTO_FIELD_IDS, ADDITIONAL_PHOTOS_FIELD_ID])(
    "omits stale RHF values for managed photo field %s even without a map entry",
    async (fieldId) => {
      vi.mocked(db.job.findUnique).mockResolvedValue({
        id: "job-1",
        status: "DRAFT",
        formData: { [fieldId]: "", [RESERVED_PHOTO_MAP_KEY]: {} },
      } as never);

      await saveFormData("job-1", {
        customer_name: "Updated customer",
        [fieldId]: "stale-photo-url",
      });
      expect(writtenPatch()).toEqual({ customer_name: "Updated customer" });
    },
  );

  it("does not resurrect a cleared mirror when reassignment commits after the autosave read", async () => {
    const newOwner = "16_photo_of_pool_pump";
    const job = {
      id: "job-1",
      status: "DRAFT",
      formData: {
        customer_name: "Old customer",
        [MULTI_FIELD]: "shared-photo",
        [newOwner]: "",
        [ADDITIONAL_PHOTOS_FIELD_ID]: "",
        [RESERVED_PHOTO_MAP_KEY]: { [MULTI_FIELD]: ["shared-photo"] },
      } as Record<string, unknown>,
    };
    vi.mocked(db.job.findUnique).mockImplementation((async () =>
      structuredClone(job)) as never);
    vi.mocked(db.$executeRaw).mockImplementation((async (
      _sql: TemplateStringsArray,
      patchJson: string,
    ) => {
      // A dedicated assignment completes before this atomic autosave UPDATE.
      job.formData[RESERVED_PHOTO_MAP_KEY] = { [newOwner]: ["shared-photo"] };
      job.formData[MULTI_FIELD] = "";
      job.formData[newOwner] = "shared-photo";
      job.formData = { ...job.formData, ...JSON.parse(patchJson) };
      return 1;
    }) as never);

    await saveFormData("job-1", {
      customer_name: "New customer",
      [MULTI_FIELD]: "shared-photo",
      [newOwner]: "",
      [ADDITIONAL_PHOTOS_FIELD_ID]: "old-additional-photo",
    });
    expect(job.formData.customer_name).toBe("New customer");
    expect(readFieldPhotoUrls(job.formData, MULTI_FIELD)).toEqual([]);
    expect(readFieldPhotoUrls(job.formData, newOwner)).toEqual([
      "shared-photo",
    ]);
    expect(job.formData[newOwner]).toBe("shared-photo");
    expect(job.formData[ADDITIONAL_PHOTOS_FIELD_ID]).toBe("");
  });

  it("also protects a legacy field currently owned by the reserved assignment map", async () => {
    const legacyField = "custom_pool_photo";
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        [legacyField]: "current-photo",
        [RESERVED_PHOTO_MAP_KEY]: { [legacyField]: ["current-photo"] },
      },
    } as never);

    await saveFormData("job-1", {
      [legacyField]: "stale-photo",
      notes: "New notes",
    });
    expect(writtenPatch()).toEqual({ notes: "New notes" });
  });

  it("preserves normal RHF changes for true legacy single-slot photo fields", async () => {
    const legacyField = "custom_pool_photo";
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: { [legacyField]: "old-photo", [RESERVED_PHOTO_MAP_KEY]: {} },
      template: { fields: [{ id: legacyField, type: "photo" }] },
    } as never);

    await saveFormData("job-1", {
      [legacyField]: "new-upload",
      notes: "New notes",
    });
    expect(writtenPatch()).toEqual({
      [legacyField]: "new-upload",
      notes: "New notes",
    });
  });

  it("accepts an initialized new template without saving client values into managed mirrors", async () => {
    const managedIds = [...MULTI_PHOTO_FIELD_IDS, ADDITIONAL_PHOTOS_FIELD_ID];
    const template: FormTemplate = {
      id: "fresh-template",
      name: "Fresh template",
      version: 1,
      fields: [
        ...managedIds.map((id, order) => ({
          id,
          order,
          label: id,
          type: "photo" as const,
          required: false,
        })),
        ...Array.from({ length: 14 }, (_, i) => ({
          id: `text_${i}`,
          order: i + managedIds.length,
          label: `Text ${i}`,
          type: "text" as const,
          required: false,
        })),
      ],
    };
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
      template,
    } as never);

    await saveFormData("job-1", {
      ...getDefaultValues(template),
      text_0: "Started",
    });
    const patch = writtenPatch();
    expect(patch.text_0).toBe("Started");
    expect(Object.keys(patch)).toHaveLength(14);
    for (const fieldId of managedIds) expect(patch).not.toHaveProperty(fieldId);
    // Optional, unassigned photo keys do not cross the submit integrity limit.
    expect(
      template.fields.filter((field) => !(field.id in patch)).length,
    ).toBeLessThanOrEqual(template.fields.length * 0.5);
  });

  it("rejects writes to SUBMITTED jobs and issues no UPDATE", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "SUBMITTED",
      formData: { customer_name: "SealedInStone" },
    } as never);

    await expect(
      saveFormData("job-1", { customer_name: "ShouldNotWrite" }),
    ).rejects.toThrow(/no longer editable/i);

    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects when the atomic UPDATE affects 0 rows (draft-flip during the write)", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: null,
    } as never);
    vi.mocked(db.$executeRaw).mockResolvedValueOnce(0 as never);

    await expect(saveFormData("job-1", { foo: "b" })).rejects.toThrow(
      /no longer editable/i,
    );
  });

  // --- Race-fix proof for the HIGH Codex finding ---

  it("concurrent dedicated-action write cannot be silently lost by autosave (race-fix structural proof)", async () => {
    // Scenario: a concurrent assignMultiFieldPhotos lands mid-flight. The
    // autosave-preserve contract is that saveFormData MUST NOT overwrite
    // any reserved `__` key at the DB. Structural proof:
    //   (1) patch contains zero __-prefixed keys — verified below,
    //   (2) SQL uses jsonb `||` merge on form_data — verified below,
    //   (3) SQL keeps the `status = 'DRAFT'` guard — verified below.
    // (1)+(2) together guarantee every reserved key in the DB survives the
    // merge because Postgres `existing || patch` is shallow: keys absent
    // from the right side are left untouched on the left.
    vi.mocked(db.job.findUnique).mockResolvedValue({
      id: "job-1",
      status: "DRAFT",
      formData: {
        foo: "a",
        [RESERVED_PHOTO_MAP_KEY]: { [MULTI_FIELD]: ["pre-flight"] },
        [RESERVED_SUMMARY_KEY]: [{ text: "t", photos: [] }],
        [REVIEWED_FLAG]: true,
      },
    } as never);

    await saveFormData("job-1", { foo: "b" });

    const patch = writtenPatch();
    expect(patch).toEqual({ foo: "b" });
    // Exhaustive: none of the known reserved keys leaked into the patch.
    expect(patch).not.toHaveProperty(RESERVED_PHOTO_MAP_KEY);
    expect(patch).not.toHaveProperty(RESERVED_SUMMARY_KEY);
    expect(patch).not.toHaveProperty(REVIEWED_FLAG);

    // Structural guarantee in the SQL itself.
    const sql = writtenSqlStatic();
    expect(sql).toMatch(/UPDATE\s+jobs/i);
    expect(sql).toMatch(/form_data\s*=\s*COALESCE\(\s*form_data/i);
    // jsonb shallow-merge operator is present (this is what preserves
    // reserved keys by virtue of their absence in the patch).
    expect(sql).toMatch(/\|\|/);
    // Draft-flip guard is atomic with the UPDATE.
    expect(sql).toMatch(/status::text\s*=\s*'DRAFT'/i);
  });
});
