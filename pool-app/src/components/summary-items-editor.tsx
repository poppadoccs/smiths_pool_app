"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveSummaryItems } from "@/lib/actions/summary";
import {
  countSummaryPhotos,
  parseSummaryItems,
  SUMMARY_FIELD_ID,
  SUMMARY_PER_ITEM_CAP,
  SUMMARY_PHOTO_SOFT_WARN,
  SUMMARY_PHOTO_TOTAL_CAP,
  SUMMARY_TEXT_MAX_LENGTH,
  type SummaryItem,
  type SummaryFieldId,
} from "@/lib/summary";
import type { FormData as JobFormData } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";
import { useJobSaveHandler } from "@/components/job-save-provider";
import {
  clearSummaryDraft,
  loadSummaryDraft,
  saveSummaryDraft,
} from "@/lib/form-draft";

// Shared editor for Q107 Summary and optional Q109 Re-Inspection Summary:
// identical bullet points, text, photo controls and capacity limits.
//
// Data ownership: items live at the field's reserved summary key, written ONLY
// through the dedicated saveSummaryItems action (autosave strips `__` keys,
// so this state deliberately lives outside react-hook-form). The legacy
// blob at formData[fieldId] is never modified here: it renders
// read-only until the worker converts it into the first bullet item.
export function SummaryItemsEditor({
  jobId,
  fieldLabel,
  fieldId = SUMMARY_FIELD_ID,
  jobPhotos,
  formData,
  disabled = false,
}: {
  jobId: string;
  fieldLabel: string;
  fieldId?: SummaryFieldId;
  jobPhotos: PhotoMetadata[];
  formData: JobFormData | null;
  disabled?: boolean;
}) {
  // null → legacy mode (blob or empty); array → structured mode.
  const [items, setItems] = useState<SummaryItem[] | null>(() =>
    parseSummaryItems(formData, fieldId),
  );
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The latest items snapshot, readable from timers without stale closures.
  // Written only in the handlers below (never during render).
  const itemsRef = useRef<SummaryItem[] | null>(items);
  // Save serialization: every save chains onto this promise, so writes
  // reach the server strictly in order and an older whole-array write can
  // never land after (and clobber) a newer one. Each queued run reads
  // itemsRef.current at RUN time, so back-to-back saves coalesce into
  // "send the latest snapshot"; lastSavedRef dedupes exact repeats.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const lastSavedRef = useRef<SummaryItem[] | null>(items);
  const restoredDraft = useRef(false);
  // Hard ceiling on unsaved typing: starts with the first debounced change
  // and is NOT reset by further keystrokes, so continuous typing still
  // persists at least every 5s.
  const maxFlushTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      clearTimeout(savedTimer.current);
      clearTimeout(maxFlushTimer.current);
    };
  }, []);

  const enqueueSave = useCallback(() => {
    const pending = saveQueue.current.then(async () => {
      const snapshot = itemsRef.current;
      if (!snapshot || snapshot === lastSavedRef.current) return;
      setSaveStatus("saving");
      try {
        const res = await saveSummaryItems(jobId, snapshot, fieldId);
        if (!res.success) {
          throw new Error(
            `${fieldLabel}: ${res.error ?? "Failed to save summary"}`,
          );
        }
        lastSavedRef.current = snapshot;
        clearSummaryDraft(jobId, fieldId, snapshot);
        setSaveStatus("saved");
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (error) {
        setSaveStatus("error");
        throw error;
      }
    });
    saveQueue.current = pending.catch(() => undefined);
    return pending;
  }, [jobId, fieldId, fieldLabel]);

  const saveInBackground = useCallback(() => {
    void enqueueSave().catch((error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to save summary",
      );
    });
  }, [enqueueSave]);

  // Structural changes (add/remove/reorder/photos) save immediately; text
  // changes debounce, flush on blur, and flush at least every 5s during
  // continuous typing so a crash mid-paragraph can't lose the paragraph.
  const clearTypingTimers = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    clearTimeout(maxFlushTimer.current);
    maxFlushTimer.current = undefined;
  }, []);

  const applyAndSave = useCallback(
    (next: SummaryItem[]) => {
      clearTypingTimers();
      itemsRef.current = next;
      setItems(next);
      saveSummaryDraft(jobId, fieldId, next);
      saveInBackground();
    },
    [clearTypingTimers, jobId, fieldId, saveInBackground],
  );

  function applyDebounced(next: SummaryItem[]) {
    itemsRef.current = next;
    setItems(next);
    setSaveStatus("idle");
    saveSummaryDraft(jobId, fieldId, next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      clearTypingTimers();
      saveInBackground();
    }, 1000);
    if (maxFlushTimer.current === undefined) {
      maxFlushTimer.current = setTimeout(() => {
        maxFlushTimer.current = undefined;
        saveInBackground();
      }, 5000);
    }
  }

  const flushPendingSave = useCallback(() => {
    clearTypingTimers();
    // Always enter the queue: a failed save has no pending typing timer,
    // and a newer snapshot may still be waiting behind an in-flight save.
    return enqueueSave();
  }, [clearTypingTimers, enqueueSave]);

  useJobSaveHandler(`summary:${fieldId}`, flushPendingSave);

  useEffect(() => {
    if (disabled) return;
    const draft = restoredDraft.current
      ? null
      : loadSummaryDraft(jobId, fieldId);
    restoredDraft.current = true;
    const current = draft ?? itemsRef.current;
    if (!current) return;
    const ownedUrls = new Set(jobPhotos.map((photo) => photo.url));
    let changed = draft !== null;
    const next = current.map((item) => {
      const photos = item.photos.filter((url) => ownedUrls.has(url));
      if (photos.length === item.photos.length) return item;
      changed = true;
      return { ...item, photos };
    });
    // Metadata refreshes may remove an attachment. Reconcile only its URLs;
    // current text (including unsaved typing) must survive router.refresh().
    if (changed) applyAndSave(next);
  }, [disabled, jobId, fieldId, jobPhotos, applyAndSave]);

  const legacyBlob =
    formData && typeof formData[fieldId] === "string"
      ? (formData[fieldId] as string).trim()
      : "";

  // --- Legacy mode: no structured items yet ---
  if (items === null) {
    return (
      <div className="space-y-2" role="group" aria-label={fieldLabel}>
        <Label className="text-base">{fieldLabel}</Label>
        {legacyBlob ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-base whitespace-pre-wrap text-zinc-700">
            {legacyBlob}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No summary yet.</p>
        )}
        {!disabled && (
          <Button
            type="button"
            variant="outline"
            className="min-h-[48px] gap-2 text-base"
            onClick={() =>
              applyAndSave(
                legacyBlob
                  ? [{ text: legacyBlob, photos: [] }]
                  : [{ text: "", photos: [] }],
              )
            }
          >
            <Plus className="size-5" />
            {legacyBlob ? "Convert to bullet points" : "Start bullet list"}
          </Button>
        )}
      </div>
    );
  }

  // --- Structured mode ---
  const totalPhotos = countSummaryPhotos(items);
  const usedUrls = new Set(items.flatMap((it) => it.photos));
  const availablePhotos = jobPhotos.filter((p) => !usedUrls.has(p.url));
  const atTotalCap = totalPhotos >= SUMMARY_PHOTO_TOTAL_CAP;

  function updateItemText(index: number, text: string) {
    applyDebounced(items!.map((it, i) => (i === index ? { ...it, text } : it)));
  }

  function addItem() {
    applyAndSave([...items!, { text: "", photos: [] }]);
  }

  function removeItem(index: number) {
    applyAndSave(items!.filter((_, i) => i !== index));
    setPickerOpenFor(null);
  }

  function moveItem(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= items!.length) return;
    const next = [...items!];
    [next[index], next[target]] = [next[target], next[index]];
    applyAndSave(next);
    setPickerOpenFor(null);
  }

  function addPhoto(index: number, url: string) {
    const item = items![index];
    if (item.photos.includes(url)) return;
    if (item.photos.length >= SUMMARY_PER_ITEM_CAP || atTotalCap) return;
    applyAndSave(
      items!.map((it, i) =>
        i === index ? { ...it, photos: [...it.photos, url] } : it,
      ),
    );
  }

  function removePhoto(index: number, url: string) {
    applyAndSave(
      items!.map((it, i) =>
        i === index
          ? { ...it, photos: it.photos.filter((u) => u !== url) }
          : it,
      ),
    );
  }

  return (
    <div
      className="space-y-3"
      data-testid="summary-items-editor"
      role="group"
      aria-label={fieldLabel}
    >
      <div className="flex items-center justify-between">
        <Label className="text-base">{fieldLabel}</Label>
        <span
          role="status"
          className="flex min-h-[20px] items-center gap-1.5 text-sm"
        >
          {saveStatus === "saving" && (
            <span className="flex items-center gap-1.5 text-zinc-500">
              <Loader2 className="size-3.5 animate-spin" />
              Saving...
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1.5 text-green-600">
              <Check className="size-3.5" />
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="text-red-600">Not saved. Use Save to retry.</span>
          )}
        </span>
      </div>

      {totalPhotos >= SUMMARY_PHOTO_SOFT_WARN && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {atTotalCap
            ? `Photo limit reached (${SUMMARY_PHOTO_TOTAL_CAP} total in the summary).`
            : `Heads up: ${totalPhotos} photos in the summary (limit ${SUMMARY_PHOTO_TOTAL_CAP}).`}
        </p>
      )}

      {items.length === 0 && (
        <p className="text-sm text-zinc-500">
          No bullet points yet — add the first one below.
        </p>
      )}

      <ul className="space-y-3">
        {items.map((item, index) => {
          const atItemCap = item.photos.length >= SUMMARY_PER_ITEM_CAP;
          const pickerOpen = pickerOpenFor === index;
          return (
            <li
              key={index}
              className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/50 p-3"
              data-testid={`summary-item-${index}`}
            >
              <div className="flex items-start gap-2">
                <span className="pt-3 text-lg leading-none text-zinc-500">
                  •
                </span>
                <Textarea
                  aria-label={`${fieldLabel} — bullet ${index + 1}`}
                  maxLength={SUMMARY_TEXT_MAX_LENGTH}
                  value={item.text}
                  placeholder="Describe this point..."
                  className="min-h-[72px] bg-white text-base"
                  disabled={disabled}
                  onChange={(e) => updateItemText(index, e.target.value)}
                  onBlur={() => {
                    clearTypingTimers();
                    saveInBackground();
                  }}
                />
                {!disabled && (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      aria-label="Move bullet up"
                      onClick={() => moveItem(index, -1)}
                      disabled={index === 0}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-200 disabled:opacity-30"
                    >
                      <ChevronUp className="size-5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move bullet down"
                      onClick={() => moveItem(index, 1)}
                      disabled={index === items.length - 1}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-200 disabled:opacity-30"
                    >
                      <ChevronDown className="size-5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Remove bullet"
                      onClick={() => removeItem(index)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                    >
                      <X className="size-5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Attached photos */}
              {item.photos.length > 0 && (
                <div className="grid grid-cols-4 gap-2 pl-6 sm:grid-cols-6">
                  {item.photos.map((url) => {
                    const meta = jobPhotos.find((p) => p.url === url);
                    return (
                      <div key={url} className="relative">
                        <div className="aspect-square overflow-hidden rounded-md border border-zinc-200">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={meta?.filename ?? "summary photo"}
                            className="size-full object-cover"
                          />
                        </div>
                        {!disabled && (
                          <button
                            type="button"
                            aria-label={`Remove ${meta?.filename ?? "photo"} from this bullet`}
                            onClick={() => removePhoto(index, url)}
                            className="absolute top-1 right-1 min-h-[28px] min-w-[28px] rounded-full bg-white/90 px-1 text-sm leading-none font-semibold text-red-600 shadow hover:bg-white"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Photo picker */}
              {!disabled && jobPhotos.length > 0 && (
                <div className="pl-6">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPickerOpenFor(pickerOpen ? null : index)}
                    disabled={!pickerOpen && (atItemCap || atTotalCap)}
                  >
                    {pickerOpen
                      ? "Done"
                      : `Add photo (${item.photos.length} of ${SUMMARY_PER_ITEM_CAP})`}
                  </Button>
                  {pickerOpen && (
                    <div className="mt-2 rounded-md border border-zinc-200 bg-white p-2">
                      <p className="mb-1 text-xs text-zinc-600">
                        Tap a photo to attach it to this bullet
                        {(atItemCap || atTotalCap) &&
                          " (at cap — remove one first)"}
                      </p>
                      {availablePhotos.length === 0 ? (
                        <p className="text-xs text-zinc-500">
                          No available photos — every uploaded photo is already
                          attached to a bullet.
                        </p>
                      ) : (
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                          {availablePhotos.map((p) => (
                            <button
                              key={p.url}
                              type="button"
                              aria-label={`Attach ${p.filename} to this bullet`}
                              onClick={() => addPhoto(index, p.url)}
                              disabled={atItemCap || atTotalCap}
                              className="aspect-square overflow-hidden rounded-md border border-zinc-200 hover:opacity-80 disabled:opacity-40"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={p.url}
                                alt={p.filename}
                                className="size-full object-cover"
                              />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {!disabled && (
        <Button
          type="button"
          variant="outline"
          className="min-h-[48px] gap-2 text-base"
          onClick={addItem}
        >
          <Plus className="size-5" />
          Add bullet point
        </Button>
      )}
    </div>
  );
}
