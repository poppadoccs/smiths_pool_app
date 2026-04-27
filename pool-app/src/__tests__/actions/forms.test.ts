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
import { RESERVED_PHOTO_MAP_KEY, REVIEWED_FLAG } from "@/lib/multi-photo";
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
