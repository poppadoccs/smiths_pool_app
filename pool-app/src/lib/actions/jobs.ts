"use server";

import { db } from "@/lib/db";
import { createJobSchema } from "@/lib/validations/job";
import { SOURCE_JOB_ID_KEY } from "@/lib/multi-photo";
import { revalidatePath } from "next/cache";

// Deep-clone a JSON-shaped value so the caller can mutate either copy
// without reaching the other. formData in particular nests the reserved
// __photoAssignmentsByField map inside the top-level object; a shallow
// spread would share that inner map by reference and risk silent cross-
// record mutation if any future code path treated the cloned object as
// mutable. JSON round-trip is the simplest correctness-first choice for
// Prisma-JSON values (no Date, no undefined members in this schema).
function cloneJsonValue<T>(value: T): T {
  return value === null || value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

// Create a DRAFT "editable copy" of a SUBMITTED job so the original
// submitted record is preserved unchanged. This is the first narrow
// slice of the resend/editable-copy workflow — it does not send email,
// does not reuse an existing DRAFT, and does not mutate the source job.
//
// Copy semantics:
//   - status: DRAFT (fresh)
//   - template: same templateId (FK copy; no template body duplication)
//   - photos:   deep clone of source photos JSON
//   - formData: deep clone of source formData (including the reserved
//               __photoAssignmentsByField map, every map-backed owner
//               bucket, Q108's map entry, remarks photo ownership, and
//               legacy mirrors). One-photo-one-owner is preserved inside
//               the copy because the whole ownership graph is cloned as
//               a self-consistent snapshot. We also write the reserved
//               __sourceJobId marker so the UI can detect this is a
//               shared-blob copy and hide destructive photo delete —
//               without this guard, deleting a photo from the copy
//               would del() the shared Vercel blob URL and break the
//               source's references to it.
//   - submittedBy/submittedAt/workerSignature: null (copy is un-submitted)
//   - name:     source name + " (copy)" suffix so the user can spot it
//               in the list without reaching into jobNumber.
//
// The source job is read-only: no update is issued against it.
export async function createEditableCopy(
  sourceJobId: string,
): Promise<{ success: boolean; newJobId?: string; error?: string }> {
  const source = await db.job.findUnique({
    where: { id: sourceJobId },
  });
  if (!source) return { success: false, error: "Source job not found" };
  if (source.status !== "SUBMITTED") {
    return {
      success: false,
      error: "Only submitted jobs can be copied for editing",
    };
  }

  const clonedPhotos = cloneJsonValue(source.photos);
  const clonedFormData =
    cloneJsonValue(source.formData) ?? ({} as Record<string, unknown>);
  // Tag the copy with the source id. Reserved `__`-prefixed key per the
  // locked formData convention — RHF autosave strips __-prefixed keys
  // before merge, so this marker can't be clobbered by a user edit.
  (clonedFormData as Record<string, unknown>)[SOURCE_JOB_ID_KEY] = source.id;

  const baseName = source.name ?? `Job #${source.jobNumber ?? source.id}`;
  const copyName = `${baseName} (copy)`;

  const copy = await db.job.create({
    data: {
      name: copyName,
      jobNumber: source.jobNumber,
      status: "DRAFT",
      ...(source.templateId ? { templateId: source.templateId } : {}),
      photos: clonedPhotos as object,
      formData: clonedFormData as object,
    },
  });

  revalidatePath("/");
  revalidatePath(`/jobs/${copy.id}`);
  return { success: true, newJobId: copy.id };
}

export async function createJob(prevState: unknown, formData: FormData) {
  const rawName = formData.get("name");
  const rawJobNumber = formData.get("jobNumber");

  const parsed = createJobSchema.safeParse({
    name:
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim()
        : undefined,
    jobNumber:
      typeof rawJobNumber === "string" && rawJobNumber.trim()
        ? rawJobNumber.trim()
        : undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.flatten().formErrors.join(", ") };
  }

  const rawTemplateId = formData.get("templateId");
  const templateId =
    typeof rawTemplateId === "string" && rawTemplateId.trim()
      ? rawTemplateId.trim()
      : null;

  await db.job.create({
    data: {
      name: parsed.data.name ?? null,
      jobNumber: parsed.data.jobNumber ?? null,
      status: "DRAFT",
      ...(templateId && { templateId }),
    },
  });

  revalidatePath("/");
  return { success: true };
}
