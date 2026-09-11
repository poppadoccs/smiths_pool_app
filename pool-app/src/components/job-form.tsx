"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useForm,
  Controller,
  type FieldErrors,
  type UseFormRegister,
  type Control,
} from "react-hook-form";
import imageCompression from "browser-image-compression";
import { COMPRESSION_OPTIONS } from "@/lib/photos";
import { zodResolver } from "@hookform/resolvers/zod";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Camera, Check, Loader2 } from "lucide-react";
import {
  buildFormSchema,
  getDefaultValues,
  isSecondaryField,
  otherTextKey,
  secondaryFieldFor,
  splitPairedLabel,
  type FormTemplate,
  type FormField,
  type FormData as JobFormData, // aliased to avoid collision with DOM FormData
} from "@/lib/forms";
import { SummaryItemsEditor } from "@/components/summary-items-editor";
import { isSummaryFieldId } from "@/lib/summary";
import { saveFormData } from "@/lib/actions/forms";
import { StickyFormNav } from "@/components/sticky-form-nav";
import { useJobSaveHandler, useJobSaves } from "@/components/job-save-provider";
import {
  clearFormDraft,
  formFieldsOnly,
  loadFormDraft,
  saveFormDraft,
} from "@/lib/form-draft";
import { ImportFromPaper } from "@/components/import-from-paper";
import { RemarksPhotosField } from "@/components/remarks-photos-field";
import { MultiPhotoField } from "@/components/multi-photo-field";
import {
  ADDITIONAL_PHOTOS_FIELD_ID,
  MULTI_PHOTO_FIELD_IDS,
} from "@/lib/multi-photo";
import type { PhotoMetadata } from "@/lib/photos";

export { clearDraft } from "@/lib/form-draft";

// --- Main form component ---

export function JobForm({
  jobId,
  template,
  initialData,
  jobPhotos = [],
  disabled = false,
}: {
  jobId: string;
  template: FormTemplate;
  initialData: JobFormData | null;
  /**
   * Authoritative job photo metadata from the server snapshot. Used by the
   * companion remarks-photo UI to resolve thumbnails and populate the
   * "Add photo" picker. Defaults to [] so existing call sites that don't
   * need remarks-photo UI can upgrade incrementally.
   */
  jobPhotos?: PhotoMetadata[];
  disabled?: boolean;
}) {
  const { isSaving, registerFormUpdater } = useJobSaves();
  const schema = useMemo(() => buildFormSchema(template), [template]);
  const defaults = useMemo(() => {
    // Layer server data over template defaults so fields added to the
    // template AFTER this draft was created (and their companion
    // `_other_text` keys) still start controlled with "" instead of
    // undefined.
    const base = getDefaultValues(template);
    return initialData ? { ...base, ...initialData } : base;
  }, [template, initialData]);
  const serverPhotoValues = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        template.fields
          .filter(
            (field) =>
              field.type === "photo" &&
              !MULTI_PHOTO_FIELD_IDS.has(field.id) &&
              field.id !== ADDITIONAL_PHOTOS_FIELD_ID,
          )
          .map((field) => {
            const value = initialData?.[field.id];
            return [field.id, typeof value === "string" ? value : ""] as const;
          }),
      ),
    [template, initialData],
  );
  const previousServerPhotoValues = useRef(serverPhotoValues);

  const {
    register,
    control,
    watch,
    reset,
    setValue,
    getValues,
    formState: { errors },
  } = useForm({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema) as any,
    defaultValues: defaults,
  });

  useEffect(
    () =>
      registerFormUpdater((values) => {
        for (const [id, value] of Object.entries(values)) {
          setValue(id, value, { shouldDirty: true });
        }
      }),
    [registerFormUpdater, setValue],
  );

  useEffect(() => {
    const previous = previousServerPhotoValues.current;
    previousServerPhotoValues.current = serverPhotoValues;
    for (const [id, value] of Object.entries(serverPhotoValues)) {
      const priorValue = previous[id] ?? "";
      // A gallery deletion or assignment can change the server's legacy
      // mirror. Accept it only while RHF still has that server snapshot;
      // a newer upload and unrelated unsaved answers must remain intact.
      if (value !== priorValue && getValues(id) === priorValue) {
        setValue(id, value, { shouldDirty: false });
      }
    }
  }, [serverPhotoValues, getValues, setValue]);

  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const dbSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const saveLatestForm = useCallback(() => {
    clearTimeout(dbSaveTimer.current);
    clearTimeout(savedTimer.current);
    const pending = saveQueue.current.then(async () => {
      // Read after earlier autosaves settle, so an older write cannot land
      // after the explicit Save/Submit snapshot.
      const values = formFieldsOnly(getValues() as JobFormData);
      setSaveStatus("saving");
      try {
        await saveFormData(jobId, values);
        clearFormDraft(jobId, values);
        setSaveStatus("saved");
        savedTimer.current = setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (error) {
        setSaveStatus("error");
        throw error;
      }
    });
    // Background failures remain retryable. The caller still receives the
    // rejecting promise, allowing Save/Submit to report and block on it.
    saveQueue.current = pending.catch(() => undefined);
    return pending;
  }, [getValues, jobId]);

  useJobSaveHandler("form", saveLatestForm);

  // Restore draft from localStorage on mount (client-only, skip if disabled)
  useEffect(() => {
    if (disabled) return;
    const draft = loadFormDraft(jobId);
    if (draft) {
      // Same layering as `defaults`: a draft saved before a template change
      // may lack newer field keys — never let those go uncontrolled.
      const restored = { ...defaults, ...draft };
      reset(restored);
      saveFormDraft(jobId, restored);
      toast.info("Draft restored");
      void saveLatestForm().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, disabled]);

  // Auto-save: localStorage immediately, DB after 2s inactivity (skip if disabled)
  useEffect(() => {
    if (disabled) return;
    const subscription = watch((values) => {
      saveFormDraft(jobId, values as JobFormData);

      clearTimeout(dbSaveTimer.current);
      clearTimeout(savedTimer.current);
      setSaveStatus("idle");
      dbSaveTimer.current = setTimeout(() => {
        void saveLatestForm().catch(() => undefined);
      }, 2000);
    });
    return () => {
      subscription.unsubscribe();
      clearTimeout(dbSaveTimer.current);
      clearTimeout(savedTimer.current);
    };
  }, [watch, jobId, disabled, saveLatestForm]);

  function handleImport(extracted: Record<string, string | boolean>) {
    // Use setValue per field so the watch() subscription fires and auto-save triggers.
    // reset() does not reliably fire watch() in RHF v7.
    for (const [id, value] of Object.entries(extracted)) {
      setValue(id as keyof JobFormData, value, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: true,
      });
    }
  }

  return (
    <fieldset
      className="min-w-0 space-y-5"
      disabled={isSaving}
      aria-busy={isSaving}
    >
      {/* Import from paper — only on draft forms */}
      {!disabled && (
        <ImportFromPaper fields={template.fields} onApply={handleImport} />
      )}

      {/* Save status indicator (hidden when disabled/submitted) */}
      {!disabled && (
        <div className="flex min-h-[20px] items-center gap-2 text-sm">
          {saveStatus === "saving" && (
            <span className="flex items-center gap-1.5 text-zinc-500">
              <Loader2 className="size-3.5 animate-spin" />
              Saving...
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1.5 text-green-600">
              <Check className="size-3.5" />
              Form fields saved
            </span>
          )}
          {saveStatus === "error" && (
            <span role="status" className="text-red-600">
              Form fields not saved. Use Save to retry.
            </span>
          )}
        </div>
      )}

      {/* Fields — with section headers for navigation */}
      {template.fields.map((field, i) => {
        // A `X_secondary` field renders inside its base field's paired
        // block (side-by-side columns under one question heading).
        if (isSecondaryField(field, template.fields)) return null;
        const secondary = secondaryFieldFor(field, template.fields);

        const prevSection = i > 0 ? template.fields[i - 1].section : undefined;
        const showSection = field.section && field.section !== prevSection;

        const setCompanionValue = (key: string, value: string) =>
          setValue(key as keyof JobFormData, value, {
            shouldDirty: true,
          });

        return (
          <div key={field.id}>
            {showSection && (
              <h3
                data-section={field.section}
                className="pt-4 pb-1 text-sm font-semibold tracking-wide text-zinc-400 uppercase"
              >
                {field.section}
              </h3>
            )}
            {secondary ? (
              <PairedFieldBlock
                field={field}
                secondary={secondary}
                register={register}
                control={control}
                errors={errors}
                disabled={disabled || isSaving}
                setCompanionValue={setCompanionValue}
              />
            ) : (
              <FieldRenderer
                field={field}
                register={register}
                control={control}
                errors={errors}
                disabled={disabled}
                jobId={jobId}
                jobPhotos={jobPhotos}
                serverFormData={initialData}
                setCompanionValue={setCompanionValue}
              />
            )}
          </div>
        );
      })}

      <StickyFormNav disabled={disabled} />
    </fieldset>
  );
}

// --- Photo field sub-component (needs useState — can't live inside a switch-case) ---

function PhotoFieldInput({
  field,
  control,
  errors,
  disabled,
  jobId,
}: {
  field: FormField;
  control: Control<JobFormData>;
  errors: FieldErrors<JobFormData>;
  disabled: boolean;
  jobId: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<string | null>(null);
  const pendingUpload = useRef<Promise<void> | null>(null);
  const failedUpload = useRef<Error | null>(null);
  const { isSaving } = useJobSaves();
  const waitForUpload = useCallback(async () => {
    if (pendingUpload.current) await pendingUpload.current;
    if (failedUpload.current) throw failedUpload.current;
  }, []);
  useJobSaveHandler(`legacy-photo:${field.id}`, waitForUpload, "prepare");
  const error = errors[field.id]?.message as string | undefined;
  const fieldId = `field-${field.id}`;

  return (
    <Controller
      name={field.id}
      control={control}
      render={({ field: rhf }) => (
        <div className="space-y-2">
          <Label htmlFor={fieldId} className="text-base">
            {field.label}
            {field.required && <span className="ml-0.5 text-red-500">*</span>}
          </Label>
          {rhf.value ? (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-green-700">
              <Camera className="size-4" />
              Photo captured
            </div>
          ) : (
            <label className="flex min-h-[100px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 bg-zinc-50 p-6 active:bg-zinc-100">
              {uploading ? (
                <>
                  <Loader2 className="size-8 animate-spin text-zinc-400" />
                  <span className="text-sm text-zinc-500">Uploading...</span>
                </>
              ) : (
                <>
                  <Camera className="size-8 text-zinc-400" />
                  <span className="text-sm text-zinc-500">
                    Tap to take photo
                  </span>
                </>
              )}
              <input
                id={fieldId}
                type="file"
                accept="image/*"
                disabled={disabled || uploading || isSaving}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file || isSaving || pendingUpload.current) return;
                  setUploading(true);
                  failedUpload.current = null;
                  setUploadFailure(null);
                  const pending = (async () => {
                    try {
                      const compressed = await imageCompression(
                        file,
                        COMPRESSION_OPTIONS,
                      );
                      const fd = new FormData();
                      fd.append("file", compressed);
                      fd.append("jobId", jobId);
                      fd.append("originalFilename", file.name);
                      fd.append(
                        "filename",
                        file.name.replace(/[^a-zA-Z0-9._-]/g, "_"),
                      );
                      const resp = await fetch("/api/photos/upload", {
                        method: "POST",
                        body: fd,
                      });
                      if (!resp.ok) throw new Error("Upload failed");
                      const { url } = await resp.json();
                      // The upload route returns only after metadata is saved.
                      rhf.onChange(url);
                    } catch (err) {
                      const failure = new Error(
                        `Photo upload failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                      );
                      failedUpload.current = failure;
                      setUploadFailure(failure.message);
                      toast.error(failure.message);
                      throw failure;
                    } finally {
                      setUploading(false);
                    }
                  })();
                  pendingUpload.current = pending;
                  void pending
                    .catch(() => undefined)
                    .finally(() => {
                      if (pendingUpload.current === pending)
                        pendingUpload.current = null;
                    });
                }}
              />
            </label>
          )}
          {uploadFailure && (
            <div className="space-y-2 text-sm text-red-600" role="alert">
              <p>{uploadFailure}</p>
              <button
                type="button"
                className="min-h-[44px] underline"
                disabled={isSaving}
                onClick={() => {
                  failedUpload.current = null;
                  setUploadFailure(null);
                }}
              >
                Continue without this photo
              </button>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    />
  );
}

// --- Paired question block ---
// Renders a base field and its `_secondary` partner as ONE question:
// shared heading, two side-by-side columns (stacked on narrow phones).
// Column headers come from the label suffix after " — ".

function PairedColumnControl({
  field,
  register,
  control,
  disabled,
  setCompanionValue,
  error,
}: {
  field: FormField;
  register: UseFormRegister<JobFormData>;
  control: Control<JobFormData>;
  disabled: boolean;
  setCompanionValue: (key: string, value: string) => void;
  error?: string;
}) {
  if (field.type === "radio") {
    return (
      <Controller
        name={field.id}
        control={control}
        render={({ field: rhf }) => (
          <div className="space-y-1">
            {field.options?.map((opt) => (
              <label
                key={opt}
                className="-mx-1 flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg px-1 select-none active:bg-zinc-50"
              >
                <input
                  type="radio"
                  name={field.id}
                  value={opt}
                  checked={rhf.value === opt}
                  onChange={() => {
                    rhf.onChange(opt);
                    if (
                      field.allowTextFor?.length &&
                      !field.allowTextFor.includes(opt)
                    ) {
                      setCompanionValue(otherTextKey(field.id), "");
                    }
                  }}
                  disabled={disabled}
                  className="size-6 accent-zinc-900"
                />
                <span className="text-base">{opt}</span>
              </label>
            ))}
            {field.allowTextFor?.includes(rhf.value as string) && (
              <Input
                aria-label={`${field.label} — details`}
                placeholder="Please specify..."
                className="min-h-[48px] text-base"
                disabled={disabled}
                {...register(otherTextKey(field.id))}
              />
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      />
    );
  }

  // text / number / etc. — single input column
  return (
    <div className="space-y-1">
      <Input
        aria-label={field.label}
        type="text"
        placeholder={field.placeholder}
        className="min-h-[48px] text-base"
        aria-invalid={!!error}
        disabled={disabled}
        {...register(field.id)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function PairedFieldBlock({
  field,
  secondary,
  register,
  control,
  errors,
  disabled = false,
  setCompanionValue,
}: {
  field: FormField;
  secondary: FormField;
  register: UseFormRegister<JobFormData>;
  control: Control<JobFormData>;
  errors: FieldErrors<JobFormData>;
  disabled?: boolean;
  setCompanionValue: (key: string, value: string) => void;
}) {
  const { title } = splitPairedLabel(field.label);
  return (
    <div className="space-y-2">
      <Label className="text-base">
        {title}
        {field.required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[field, secondary].map((f, i) => (
          <div
            key={f.id}
            className="space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50/40 p-3"
          >
            <p className="text-sm font-semibold text-zinc-600">
              {splitPairedLabel(f.label).column ||
                (i === 0 ? "Main" : "Secondary")}
            </p>
            <PairedColumnControl
              field={f}
              register={register}
              control={control}
              disabled={disabled}
              setCompanionValue={setCompanionValue}
              error={errors[f.id]?.message as string | undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Field renderer ---

function FieldRenderer({
  field,
  register,
  control,
  errors,
  disabled = false,
  jobId,
  jobPhotos,
  serverFormData,
  setCompanionValue,
}: {
  field: FormField;
  register: UseFormRegister<JobFormData>;
  control: Control<JobFormData>;
  errors: FieldErrors<JobFormData>;
  disabled?: boolean;
  jobId: string;
  jobPhotos: PhotoMetadata[];
  serverFormData: JobFormData | null;
  setCompanionValue: (key: string, value: string) => void;
}) {
  const { isSaving } = useJobSaves();
  const controlsDisabled = disabled || isSaving;
  const error = errors[field.id]?.message as string | undefined;
  const fieldId = `field-${field.id}`;

  switch (field.type) {
    case "text":
    case "number":
    case "phone":
    case "email":
    case "date":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={fieldId} className="text-base">
            {field.label}
            {field.required && <span className="ml-0.5 text-red-500">*</span>}
          </Label>
          <Input
            id={fieldId}
            type={field.type === "date" ? "date" : "text"}
            inputMode={
              field.type === "number"
                ? "decimal"
                : field.type === "phone"
                  ? "tel"
                  : field.type === "email"
                    ? "email"
                    : "text"
            }
            placeholder={field.placeholder}
            className="min-h-[48px] text-base"
            aria-invalid={!!error}
            disabled={controlsDisabled}
            {...register(field.id)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      );

    case "signature":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={fieldId} className="text-base">
            {field.label}
            {field.required && <span className="ml-0.5 text-red-500">*</span>}
          </Label>
          <Input
            id={fieldId}
            type="text"
            placeholder={field.placeholder || "Type name as signature"}
            className="min-h-[48px] text-base italic"
            aria-invalid={!!error}
            disabled={controlsDisabled}
            {...register(field.id)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      );

    case "textarea":
      // Q107 and Q109 share the bullet-item editor (text + photos per
      // bullet) with independent storage. Legacy blob text
      // stays readable inside the editor and is never auto-deleted.
      if (isSummaryFieldId(field.id)) {
        return (
          <SummaryItemsEditor
            jobId={jobId}
            fieldLabel={field.label}
            fieldId={field.id}
            jobPhotos={jobPhotos}
            formData={serverFormData}
            disabled={disabled}
          />
        );
      }
      return (
        <div className="space-y-1.5">
          <Label htmlFor={fieldId} className="text-base">
            {field.label}
            {field.required && <span className="ml-0.5 text-red-500">*</span>}
          </Label>
          <Textarea
            id={fieldId}
            placeholder={field.placeholder}
            className="min-h-[96px] text-base"
            aria-invalid={!!error}
            disabled={controlsDisabled}
            {...register(field.id)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          {/* Companion remarks-photo UI: the component is a no-op for any
              textarea id that isn't a remarks note, so wiring it here is
              safe for every textarea case. The textarea's RHF value (note
              text) and the photo bucket are stored under completely
              different keys — no collision is possible. */}
          <RemarksPhotosField
            jobId={jobId}
            textareaFieldId={field.id}
            jobPhotos={jobPhotos}
            formData={serverFormData}
            disabled={controlsDisabled}
          />
        </div>
      );

    case "checkbox":
      return (
        <Controller
          name={field.id}
          control={control}
          render={({ field: rhf }) => (
            <label
              className="-mx-2 flex min-h-[56px] cursor-pointer items-center gap-3 rounded-lg px-2 active:bg-zinc-50"
              onClick={(e) => {
                if (controlsDisabled) return;
                if ((e.target as HTMLElement).closest('[data-slot="checkbox"]'))
                  return;
                e.preventDefault();
                rhf.onChange(!rhf.value);
              }}
            >
              <Checkbox
                id={fieldId}
                checked={rhf.value as boolean}
                onCheckedChange={(checked) => rhf.onChange(checked)}
                className="size-7"
                disabled={controlsDisabled}
              />
              <span className="text-base select-none">{field.label}</span>
            </label>
          )}
        />
      );

    case "select":
      return (
        <Controller
          name={field.id}
          control={control}
          render={({ field: rhf }) => (
            <div className="space-y-1.5">
              <Label className="text-base">
                {field.label}
                {field.required && (
                  <span className="ml-0.5 text-red-500">*</span>
                )}
              </Label>
              <Select
                value={rhf.value as string}
                onValueChange={(val) => rhf.onChange(val)}
                disabled={controlsDisabled}
              >
                <SelectTrigger className="min-h-[48px] w-full text-base">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {field.options?.map((opt) => (
                    <SelectItem
                      key={opt}
                      value={opt}
                      className="min-h-[44px] text-base"
                    >
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        />
      );

    case "radio":
      return (
        <Controller
          name={field.id}
          control={control}
          render={({ field: rhf }) => (
            <div className="space-y-2">
              <Label className="text-base">
                {field.label}
                {field.required && (
                  <span className="ml-0.5 text-red-500">*</span>
                )}
              </Label>
              <div className="space-y-1">
                {field.options?.map((opt) => (
                  <label
                    key={opt}
                    className="-mx-2 flex min-h-[48px] cursor-pointer items-center gap-3 rounded-lg px-2 select-none active:bg-zinc-50"
                  >
                    <input
                      type="radio"
                      name={field.id}
                      value={opt}
                      checked={rhf.value === opt}
                      onChange={() => {
                        rhf.onChange(opt);
                        // Switching to a non-triggering option clears the
                        // companion text so stale details never linger in
                        // the saved data.
                        if (
                          field.allowTextFor?.length &&
                          !field.allowTextFor.includes(opt)
                        ) {
                          setCompanionValue(otherTextKey(field.id), "");
                        }
                      }}
                      disabled={controlsDisabled}
                      className="size-6 accent-zinc-900"
                    />
                    <span className="text-base">{opt}</span>
                  </label>
                ))}
              </div>
              {field.allowTextFor?.includes(rhf.value as string) && (
                <Input
                  aria-label={`${field.label} — details`}
                  placeholder="Please specify..."
                  className="min-h-[48px] text-base"
                  disabled={controlsDisabled}
                  {...register(otherTextKey(field.id))}
                />
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        />
      );

    case "photo":
      // Map-backed photo owners (multi-photo Q5/Q16/Q25/Q40/Q71 + Q108)
      // use a dedicated companion UI that supports gallery pick, capture,
      // previews, and remove — all routed through their dedicated server
      // actions. True single-slot photo fields (e.g. pool_hero_photo)
      // keep the original PhotoFieldInput so RHF still owns their value.
      if (
        MULTI_PHOTO_FIELD_IDS.has(field.id) ||
        field.id === ADDITIONAL_PHOTOS_FIELD_ID
      ) {
        return (
          <MultiPhotoField
            jobId={jobId}
            field={field}
            jobPhotos={jobPhotos}
            formData={serverFormData}
            disabled={disabled}
          />
        );
      }
      return (
        <PhotoFieldInput
          field={field}
          control={control}
          errors={errors}
          disabled={controlsDisabled}
          jobId={jobId}
        />
      );
  }
}
