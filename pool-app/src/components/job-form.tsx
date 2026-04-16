"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useForm,
  Controller,
  type FieldErrors,
  type UseFormRegister,
  type Control,
} from "react-hook-form";
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
  type FormTemplate,
  type FormField,
  type FormData,
} from "@/lib/forms";
import { saveFormData } from "@/lib/actions/forms";
import { StickyFormNav } from "@/components/sticky-form-nav";
import { ImportFromPaper } from "@/components/import-from-paper";

// --- localStorage draft helpers ---

const DRAFT_KEY = (jobId: string) => `form-draft-${jobId}`;

function loadDraft(jobId: string): FormData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(DRAFT_KEY(jobId));
    if (!raw) return null;
    return JSON.parse(raw).data;
  } catch {
    return null;
  }
}

function saveDraftToStorage(jobId: string, data: FormData) {
  try {
    localStorage.setItem(
      DRAFT_KEY(jobId),
      JSON.stringify({ data, savedAt: Date.now() }),
    );
  } catch {
    // localStorage full or unavailable — silent fail, DB save is backup
  }
}

export function clearDraft(jobId: string) {
  try {
    localStorage.removeItem(DRAFT_KEY(jobId));
  } catch {
    // ignore
  }
}

// --- Main form component ---

export function JobForm({
  jobId,
  template,
  initialData,
  disabled = false,
}: {
  jobId: string;
  template: FormTemplate;
  initialData: FormData | null;
  disabled?: boolean;
}) {
  const schema = useMemo(() => buildFormSchema(template), [template]);
  const defaults = useMemo(() => {
    if (initialData) return initialData;
    return getDefaultValues(template);
  }, [template, initialData]);

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

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const dbSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Restore draft from localStorage on mount (client-only, skip if disabled)
  useEffect(() => {
    if (disabled) return;
    const draft = loadDraft(jobId);
    if (draft) {
      reset(draft);
      toast.info("Draft restored");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, disabled]);

  // Auto-save: localStorage immediately, DB after 2s inactivity (skip if disabled)
  useEffect(() => {
    if (disabled) return;
    const subscription = watch((values) => {
      saveDraftToStorage(jobId, values as FormData);

      clearTimeout(dbSaveTimer.current);
      clearTimeout(savedTimer.current);
      dbSaveTimer.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          await saveFormData(jobId, values as FormData);
          clearDraft(jobId);
          setSaveStatus("saved");
          savedTimer.current = setTimeout(() => setSaveStatus("idle"), 2000);
        } catch {
          setSaveStatus("idle");
        }
      }, 2000);
    });
    return () => {
      subscription.unsubscribe();
      clearTimeout(dbSaveTimer.current);
      clearTimeout(savedTimer.current);
    };
  }, [watch, jobId, disabled]);

  function handleImport(extracted: Record<string, string | boolean>) {
    // Use setValue per field so the watch() subscription fires and auto-save triggers.
    // reset() does not reliably fire watch() in RHF v7.
    for (const [id, value] of Object.entries(extracted)) {
      setValue(id as keyof FormData, value, {
        shouldDirty: true,
        shouldTouch: true,
      });
    }
  }

  return (
    <div className="space-y-5">
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
              Saved
            </span>
          )}
        </div>
      )}

      {/* Fields — with section headers for navigation */}
      {template.fields.map((field, i) => {
        const prevSection = i > 0 ? template.fields[i - 1].section : undefined;
        const showSection = field.section && field.section !== prevSection;

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
            <FieldRenderer
              field={field}
              register={register}
              control={control}
              errors={errors}
              disabled={disabled}
            />
          </div>
        );
      })}

      <StickyFormNav
        jobId={jobId}
        getValues={() => getValues() as FormData}
        disabled={disabled}
      />
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
}: {
  field: FormField;
  register: UseFormRegister<FormData>;
  control: Control<FormData>;
  errors: FieldErrors<FormData>;
  disabled?: boolean;
}) {
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
            disabled={disabled}
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
            disabled={disabled}
            {...register(field.id)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      );

    case "textarea":
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
            disabled={disabled}
            {...register(field.id)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
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
                if (disabled) return;
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
                disabled={disabled}
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
                disabled={disabled}
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
                      onChange={() => rhf.onChange(opt)}
                      disabled={disabled}
                      className="size-6 accent-zinc-900"
                    />
                    <span className="text-base">{opt}</span>
                  </label>
                ))}
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        />
      );

    case "photo":
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
              {rhf.value ? (
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-green-700">
                  <Camera className="size-4" />
                  Photo captured
                </div>
              ) : (
                <label className="flex min-h-[100px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 bg-zinc-50 p-6 active:bg-zinc-100">
                  <Camera className="size-8 text-zinc-400" />
                  <span className="text-sm text-zinc-500">
                    Tap to take photo
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={disabled}
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        console.log("[photo] file selected:", file.name);
                        rhf.onChange(file.name);
                      }
                    }}
                  />
                </label>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        />
      );
  }
}
