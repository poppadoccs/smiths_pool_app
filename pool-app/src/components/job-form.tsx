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
import { Check, Loader2 } from "lucide-react";
import {
  buildFormSchema,
  getDefaultValues,
  type FormTemplate,
  type FormField,
  type FormData,
} from "@/lib/forms";
import { saveFormData } from "@/lib/actions/forms";

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
      JSON.stringify({ data, savedAt: Date.now() })
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
    formState: { errors },
  } = useForm({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(schema) as any,
    defaultValues: defaults,
  });

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle"
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

  return (
    <div className="space-y-5">
      {/* Save status indicator (hidden when disabled/submitted) */}
      {!disabled && (
        <div className="flex items-center gap-2 text-sm min-h-[20px]">
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

      {/* Fields */}
      {template.fields.map((field) => (
        <FieldRenderer
          key={field.id}
          field={field}
          register={register}
          control={control}
          errors={errors}
          disabled={disabled}
        />
      ))}
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
            {field.required && <span className="text-red-500 ml-0.5">*</span>}
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
            {field.required && <span className="text-red-500 ml-0.5">*</span>}
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
            {field.required && <span className="text-red-500 ml-0.5">*</span>}
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
            <div className="flex items-center gap-3 min-h-[48px]">
              <Checkbox
                id={fieldId}
                checked={rhf.value as boolean}
                onCheckedChange={(checked) => rhf.onChange(checked)}
                className="size-6"
                disabled={disabled}
              />
              <Label htmlFor={fieldId} className="text-base cursor-pointer">
                {field.label}
              </Label>
            </div>
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
                  <span className="text-red-500 ml-0.5">*</span>
                )}
              </Label>
              <Select
                value={rhf.value as string}
                onValueChange={(val) => rhf.onChange(val)}
                disabled={disabled}
              >
                <SelectTrigger className="w-full min-h-[48px] text-base">
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
                  <span className="text-red-500 ml-0.5">*</span>
                )}
              </Label>
              <div className="space-y-1">
                {field.options?.map((opt) => (
                  <label
                    key={opt}
                    className="flex items-center gap-3 min-h-[44px] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name={field.id}
                      value={opt}
                      checked={rhf.value === opt}
                      onChange={() => rhf.onChange(opt)}
                      disabled={disabled}
                      className="size-5 accent-zinc-900"
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
  }
}
