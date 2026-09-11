import type { FormData } from "@/lib/forms";
import {
  parseSummaryItems,
  summaryKeyFor,
  type SummaryFieldId,
  type SummaryItem,
} from "@/lib/summary";

type Draft = {
  data?: FormData;
  summaries?: Partial<Record<SummaryFieldId, SummaryItem[]>>;
  savedAt?: number;
};

const draftKey = (jobId: string) => `form-draft-${jobId}`;

function readDraft(jobId: string): Draft {
  try {
    const raw = localStorage.getItem(draftKey(jobId));
    const draft = raw ? JSON.parse(raw) : null;
    return draft && typeof draft === "object" ? draft : {};
  } catch {
    return {};
  }
}

function writeDraft(jobId: string, draft: Draft) {
  try {
    if (!draft.data && !Object.keys(draft.summaries ?? {}).length) {
      localStorage.removeItem(draftKey(jobId));
    } else {
      localStorage.setItem(
        draftKey(jobId),
        JSON.stringify({ ...draft, savedAt: Date.now() }),
      );
    }
  } catch {
    // Storage can be unavailable/full. Server saves still report failure
    // and block submission; navigation recovery is best effort in that case.
  }
}

export function formFieldsOnly(data: FormData): FormData {
  return Object.fromEntries(
    Object.entries(data).filter(
      ([key, value]) => !key.startsWith("__") && value !== undefined,
    ),
  );
}

export function loadFormDraft(jobId: string): FormData | null {
  const data = readDraft(jobId).data;
  return data && typeof data === "object" ? formFieldsOnly(data) : null;
}

export function saveFormDraft(jobId: string, data: FormData) {
  writeDraft(jobId, { ...readDraft(jobId), data: formFieldsOnly(data) });
}

export function clearFormDraft(jobId: string, saved: FormData) {
  const draft = readDraft(jobId);
  // A slow save must never erase newer typing or either summary's draft.
  if (JSON.stringify(draft.data) !== JSON.stringify(formFieldsOnly(saved)))
    return;
  delete draft.data;
  writeDraft(jobId, draft);
}

export function loadSummaryDraft(jobId: string, fieldId: SummaryFieldId) {
  const items = readDraft(jobId).summaries?.[fieldId];
  return parseSummaryItems({ [summaryKeyFor(fieldId)!]: items }, fieldId);
}

export function saveSummaryDraft(
  jobId: string,
  fieldId: SummaryFieldId,
  items: SummaryItem[],
) {
  const draft = readDraft(jobId);
  draft.summaries = { ...draft.summaries, [fieldId]: items };
  writeDraft(jobId, draft);
}

export function clearSummaryDraft(
  jobId: string,
  fieldId: SummaryFieldId,
  saved: SummaryItem[],
) {
  const draft = readDraft(jobId);
  if (JSON.stringify(draft.summaries?.[fieldId]) !== JSON.stringify(saved))
    return;
  delete draft.summaries![fieldId];
  writeDraft(jobId, draft);
}

export function clearDraft(jobId: string) {
  try {
    localStorage.removeItem(draftKey(jobId));
  } catch {
    // Ignore unavailable storage after a successful submission.
  }
}
