"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { FormData } from "@/lib/forms";
import {
  ADDITIONAL_PHOTOS_FIELD_ID,
  MULTI_PHOTO_FIELD_IDS,
  RESERVED_PHOTO_MAP_KEY,
} from "@/lib/multi-photo";

// Autosave writer for the job-form RHF state. See plan 260417-mpf §AUTOSAVE-PRESERVE.
//
// Invariants this function enforces:
//   1. Atomic jsonb merge at the DB — the write is a single `UPDATE ... SET
//      form_data = form_data || patch` statement using Postgres' shallow
//      jsonb merge operator. There is NO read-then-write TOCTOU window in
//      which a concurrent dedicated-action write (e.g. assignMultiFieldPhotos)
//      can be silently overwritten. The patch contains zero reserved keys
//      (stripped below), so any `__`-prefixed key already in form_data
//      survives untouched because it is not in the patch.
//   2. Submitted-job immunity — a status flip between page-load and the
//      UPDATE MUST NOT corrupt the submitted record. Guarded by the atomic
//      `AND status::text = 'DRAFT'` clause in the UPDATE.
//   3. Reserved keys (prefix `__`) and managed photo mirrors belong to dedicated actions
//      (assignMultiFieldPhotos, savePhotoAssignments, saveSummaryItems).
//      This channel strips any `__` key from the client payload before the
//      patch is built, so RHF can never overwrite them even if something in
//      the client accidentally serialized one. Stale RHF photo mirrors must
//      not resurrect an owner removed by a dedicated assignment action.
//   4. `undefined` RHF values are filtered (never written), so a missing RHF
//      key can't delete a DB value — a missing key in the patch leaves the
//      DB value untouched under the jsonb merge.
export async function saveFormData(jobId: string, formData: FormData) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { template: true },
  });
  if (!job) throw new Error("Job not found");
  if (job.status !== "DRAFT") {
    throw new Error("Job is no longer editable");
  }

  // Structural integrity: verify expected field IDs are present in the payload.
  // RHF initializes all keys, so a mismatch means the form was loaded with
  // the wrong template or the payload was corrupted in transit.
  const templateFields = Array.isArray(job.template?.fields)
    ? (job.template.fields as { id: string }[])
    : [];
  const payloadKeys = new Set(Object.keys(formData));
  const missingIds = templateFields
    .map((f) => f.id)
    .filter((id) => !payloadKeys.has(id));

  console.log(
    `[save] Job ${jobId}: ${payloadKeys.size} keys, template expects ${templateFields.length}, missing ${missingIds.length}`,
  );

  if (
    templateFields.length >= 20 &&
    missingIds.length > templateFields.length * 0.5
  ) {
    const msg = `Data integrity error: ${missingIds.length}/${templateFields.length} expected field IDs missing from payload. Aborting save.`;
    console.error(`[save] ${msg}`);
    throw new Error(msg);
  }

  // Managed photo fields stay assignment-owned even after their map entry is
  // removed. Also protect any other owner present in a legacy assignment map.
  // Ordinary single-slot photo fields remain RHF-owned when they have no map.
  const managedPhotoIds = new Set([
    ...MULTI_PHOTO_FIELD_IDS,
    ADDITIONAL_PHOTOS_FIELD_ID,
  ]);
  const existing = job.formData as FormData | null;
  const photoMap = existing?.[RESERVED_PHOTO_MAP_KEY];
  if (photoMap && typeof photoMap === "object" && !Array.isArray(photoMap)) {
    for (const fieldId of Object.keys(photoMap)) managedPhotoIds.add(fieldId);
  }

  // Build the patch: drop `undefined` values (can't delete a DB key by
  // accident under jsonb merge) and strip `__`-prefixed keys (reserved-key
  // channel; client is never trusted through autosave). A stripped reserved
  // key is a bug signal. The resulting patch contains only template-field
  // keys RHF owns — reserved keys and managed photo mirrors are omitted.
  const patch: Record<string, unknown> = {};
  const strippedReservedKeys: string[] = [];
  for (const [k, v] of Object.entries(formData)) {
    if (v === undefined) continue;
    if (k.startsWith("__")) {
      strippedReservedKeys.push(k);
      continue;
    }
    if (managedPhotoIds.has(k)) continue;
    patch[k] = v;
  }
  if (strippedReservedKeys.length > 0) {
    console.warn(
      `[save] Job ${jobId}: stripped ${strippedReservedKeys.length} __-prefixed keys from client payload: ${strippedReservedKeys.join(", ")}. Dedicated server actions own these keys — autosave must not write them.`,
    );
  }

  // Atomic jsonb shallow merge: `existing || patch`. Right side wins for
  // overlapping keys, so patch keys overwrite the template-field values RHF
  // owns, while every reserved `__` key in the existing form_data survives
  // untouched (patch contains no `__` key by construction). This closes the
  // TOCTOU race that would let a concurrent dedicated-action write be
  // silently overwritten by a read-then-write autosave.
  //
  // The `AND status::text = 'DRAFT'` guard is atomic with the write: if the
  // status flipped between the findUnique above and this UPDATE, affected
  // is 0 and we refuse by throwing.
  const patchJson = JSON.stringify(patch);
  const affected = await db.$executeRaw`
    UPDATE jobs
    SET form_data = COALESCE(form_data, '{}'::jsonb) || ${patchJson}::jsonb
    WHERE id = ${jobId} AND status::text = 'DRAFT'
  `;
  if (affected === 0) {
    throw new Error("Job is no longer editable");
  }

  revalidatePath(`/jobs/${jobId}`);
}
