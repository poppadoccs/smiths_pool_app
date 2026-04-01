"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Save,
  X,
  Pencil,
} from "lucide-react";
import {
  FIELD_TYPES,
  type FormField,
  type FieldType,
} from "@/lib/forms";
import {
  createTemplate,
  updateTemplate,
} from "@/lib/actions/templates";

// --- Plain-English labels for field types ---
const TYPE_LABELS: Record<FieldType, string> = {
  text: "Short answer",
  textarea: "Long answer",
  number: "Number",
  date: "Date",
  checkbox: "Yes / No",
  radio: "Pick one",
  select: "Dropdown",
  phone: "Phone number",
  email: "Email address",
  signature: "Signature",
};

type TemplateEditorProps = {
  mode: "create" | "edit";
  templateId?: string;
  initialName?: string;
  initialDescription?: string;
  initialCategory?: string;
  initialFields?: FormField[];
  onSaved?: (id: string) => void;
};

function generateFieldId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return base || `field_${Date.now()}`;
}

function makeEmptyField(order: number, section?: string): FormField {
  return {
    id: `field_${Date.now()}_${order}`,
    label: "",
    type: "text",
    required: false,
    section,
    order,
  };
}

// --- Group fields by section, preserving order ---
type SectionGroup = {
  section: string;
  fields: { field: FormField; globalIndex: number }[];
};

function groupBySection(fields: FormField[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  let current: SectionGroup | null = null;

  for (let i = 0; i < fields.length; i++) {
    const sectionName = fields[i].section || "General";
    if (!current || current.section !== sectionName) {
      current = { section: sectionName, fields: [] };
      groups.push(current);
    }
    current.fields.push({ field: fields[i], globalIndex: i });
  }

  return groups;
}

export function TemplateEditor({
  mode,
  templateId,
  initialName = "",
  initialDescription = "",
  initialCategory = "",
  initialFields = [],
  onSaved,
}: TemplateEditorProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [category, setCategory] = useState(initialCategory);
  const [fields, setFields] = useState<FormField[]>(
    initialFields.length > 0 ? initialFields : [makeEmptyField(0)]
  );
  const [saving, setSaving] = useState(false);
  const [deleteFieldIdx, setDeleteFieldIdx] = useState<number | null>(null);
  const [expandedField, setExpandedField] = useState<number | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set()
  );

  const sections = useMemo(() => groupBySection(fields), [fields]);

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const addField = useCallback((section?: string) => {
    setFields((prev) => {
      // Insert at end of the section, or at end if no section
      if (section) {
        const lastInSection = [...prev]
          .reverse()
          .findIndex((f) => (f.section || "General") === section);
        const insertAt =
          lastInSection >= 0 ? prev.length - lastInSection : prev.length;
        const next = [
          ...prev.slice(0, insertAt),
          makeEmptyField(insertAt, section === "General" ? undefined : section),
          ...prev.slice(insertAt),
        ];
        return next.map((f, i) => ({ ...f, order: i }));
      }
      return [...prev, makeEmptyField(prev.length)];
    });
  }, []);

  const removeField = useCallback((index: number) => {
    setFields((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.map((f, i) => ({ ...f, order: i }));
    });
    setDeleteFieldIdx(null);
    setExpandedField(null);
  }, []);

  const moveField = useCallback(
    (index: number, direction: "up" | "down") => {
      setFields((prev) => {
        const next = [...prev];
        const targetIdx = direction === "up" ? index - 1 : index + 1;
        if (targetIdx < 0 || targetIdx >= next.length) return prev;
        [next[index], next[targetIdx]] = [next[targetIdx], next[index]];
        return next.map((f, i) => ({ ...f, order: i }));
      });
      setExpandedField((prev) => {
        if (prev === index)
          return direction === "up" ? index - 1 : index + 1;
        return prev;
      });
    },
    []
  );

  const updateField = useCallback(
    (index: number, updates: Partial<FormField>) => {
      setFields((prev) =>
        prev.map((f, i) => {
          if (i !== index) return f;
          const updated = { ...f, ...updates };
          if (updates.label !== undefined && updates.label.trim()) {
            updated.id = generateFieldId(updates.label);
          }
          if (
            updates.type &&
            updates.type !== "select" &&
            updates.type !== "radio"
          ) {
            updated.options = undefined;
          }
          return updated;
        })
      );
    },
    []
  );

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Template name is required");
      return;
    }

    const validFields = fields.filter((f) => f.label.trim());
    if (validFields.length === 0) {
      toast.error("Add at least one field");
      return;
    }

    const seen = new Set<string>();
    const deduped = validFields.map((f, i) => {
      let fieldId = f.id;
      let counter = 1;
      while (seen.has(fieldId)) {
        fieldId = `${f.id}_${counter++}`;
      }
      seen.add(fieldId);
      return { ...f, id: fieldId, order: i };
    });

    setSaving(true);
    try {
      if (mode === "edit" && templateId) {
        const result = await updateTemplate(templateId, {
          name: name.trim(),
          description,
          category,
          fields: deduped,
        });
        if (!result.success) {
          toast.error(result.error || "Failed to save");
          return;
        }
        toast.success("Template updated");
        onSaved?.(templateId);
      } else {
        const result = await createTemplate({
          name: name.trim(),
          description,
          category,
          fields: deduped,
        });
        if (!result.success) {
          toast.error(result.error || "Failed to create");
          return;
        }
        toast.success("Template created");
        if (result.id) {
          onSaved?.(result.id);
          router.push("/templates");
        }
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Template info */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name" className="text-base">
              Template Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Pool Installation Checklist"
              className="min-h-[48px] text-base"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-desc" className="text-base">
              Description
            </Label>
            <Input
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this form for?"
              className="min-h-[48px] text-base"
            />
          </div>
        </CardContent>
      </Card>

      {/* Sections + Fields */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900">
            {fields.length} field{fields.length !== 1 ? "s" : ""}
            {sections.length > 1 &&
              ` in ${sections.length} section${sections.length !== 1 ? "s" : ""}`}
          </h2>
        </div>

        {sections.map((group) => {
          const isCollapsed = collapsedSections.has(group.section);
          return (
            <div key={group.section} className="space-y-2">
              {/* Section header */}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg bg-zinc-100 px-4 py-3 text-left active:bg-zinc-200"
                onClick={() => toggleSection(group.section)}
              >
                <ChevronRight
                  className={`size-4 text-zinc-500 transition-transform ${
                    isCollapsed ? "" : "rotate-90"
                  }`}
                />
                <span className="flex-1 text-base font-semibold text-zinc-800">
                  {group.section}
                </span>
                <span className="text-sm text-zinc-500">
                  {group.fields.length}
                </span>
              </button>

              {/* Fields in this section */}
              {!isCollapsed && (
                <div className="space-y-1.5 pl-2">
                  {group.fields.map(({ field, globalIndex }) => {
                    const isExpanded = expandedField === globalIndex;
                    return (
                      <div key={`f-${globalIndex}`}>
                        {/* Compact field row */}
                        <button
                          type="button"
                          className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                            isExpanded
                              ? "border-zinc-300 bg-white"
                              : "border-zinc-200 bg-white active:bg-zinc-50"
                          }`}
                          onClick={() =>
                            setExpandedField(isExpanded ? null : globalIndex)
                          }
                        >
                          {/* Required dot */}
                          <div
                            className={`size-2 shrink-0 rounded-full ${
                              field.required
                                ? "bg-red-500"
                                : "bg-zinc-200"
                            }`}
                            title={field.required ? "Required" : "Optional"}
                          />

                          {/* Label */}
                          <span className="flex-1 text-base text-zinc-900 truncate">
                            {field.label || (
                              <span className="italic text-zinc-400">
                                Untitled field
                              </span>
                            )}
                          </span>

                          {/* Type chip */}
                          <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600">
                            {TYPE_LABELS[field.type] || field.type}
                          </span>

                          {/* Options count for radio/select */}
                          {field.options && field.options.length > 0 && (
                            <span className="shrink-0 text-xs text-zinc-400">
                              {field.options.length} options
                            </span>
                          )}

                          <Pencil className="size-3.5 shrink-0 text-zinc-400" />
                        </button>

                        {/* Expanded edit panel */}
                        {isExpanded && (
                          <div className="ml-2 mt-1 space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                            {/* Label */}
                            <div className="space-y-1">
                              <Label className="text-sm">Question text</Label>
                              <Input
                                value={field.label}
                                onChange={(e) =>
                                  updateField(globalIndex, {
                                    label: e.target.value,
                                  })
                                }
                                placeholder="e.g., 3. Gate Code / Access"
                                className="min-h-[44px] text-base"
                              />
                            </div>

                            {/* Type + Required */}
                            <div className="flex gap-3 items-end">
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm">Answer type</Label>
                                <Select
                                  value={field.type}
                                  onValueChange={(val) =>
                                    updateField(globalIndex, {
                                      type: (val ?? field.type) as FieldType,
                                    })
                                  }
                                >
                                  <SelectTrigger className="min-h-[44px] text-base">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {FIELD_TYPES.map((ft) => (
                                      <SelectItem
                                        key={ft.value}
                                        value={ft.value}
                                        className="min-h-[40px] text-base"
                                      >
                                        {ft.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="flex items-center gap-2 min-h-[44px] pb-0.5">
                                <Checkbox
                                  id={`req-${globalIndex}`}
                                  checked={field.required}
                                  onCheckedChange={(checked) =>
                                    updateField(globalIndex, {
                                      required: !!checked,
                                    })
                                  }
                                  className="size-5"
                                />
                                <Label
                                  htmlFor={`req-${globalIndex}`}
                                  className="text-sm cursor-pointer"
                                >
                                  Required
                                </Label>
                              </div>
                            </div>

                            {/* Placeholder */}
                            {[
                              "text",
                              "textarea",
                              "number",
                              "phone",
                              "email",
                              "date",
                            ].includes(field.type) && (
                              <div className="space-y-1">
                                <Label className="text-sm">
                                  Hint text (placeholder)
                                </Label>
                                <Input
                                  value={field.placeholder || ""}
                                  onChange={(e) =>
                                    updateField(globalIndex, {
                                      placeholder: e.target.value,
                                    })
                                  }
                                  placeholder="e.g., Enter the address..."
                                  className="min-h-[40px] text-sm"
                                />
                              </div>
                            )}

                            {/* Options */}
                            {(field.type === "select" ||
                              field.type === "radio") && (
                              <div className="space-y-1">
                                <Label className="text-sm">
                                  Choices (one per line)
                                </Label>
                                <Textarea
                                  value={(field.options || []).join("\n")}
                                  onChange={(e) =>
                                    updateField(globalIndex, {
                                      options: e.target.value
                                        .split("\n")
                                        .map((s) => s.trim())
                                        .filter(Boolean),
                                    })
                                  }
                                  placeholder={
                                    "Option A\nOption B\nOption C"
                                  }
                                  className="min-h-[80px] text-sm"
                                />
                              </div>
                            )}

                            {/* Section */}
                            <div className="space-y-1">
                              <Label className="text-sm">Section</Label>
                              <Input
                                value={field.section || ""}
                                onChange={(e) =>
                                  updateField(globalIndex, {
                                    section: e.target.value,
                                  })
                                }
                                placeholder="e.g., I. Site Logistics"
                                className="min-h-[40px] text-sm"
                              />
                            </div>

                            {/* Move + Delete */}
                            <div className="flex items-center gap-2 pt-1">
                              <Button
                                variant="outline"
                                size="sm"
                                className="min-h-[36px] gap-1"
                                disabled={globalIndex === 0}
                                onClick={() => moveField(globalIndex, "up")}
                              >
                                <ChevronUp className="size-3.5" />
                                Up
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="min-h-[36px] gap-1"
                                disabled={
                                  globalIndex === fields.length - 1
                                }
                                onClick={() =>
                                  moveField(globalIndex, "down")
                                }
                              >
                                <ChevronDown className="size-3.5" />
                                Down
                              </Button>
                              <div className="flex-1" />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="min-h-[36px] gap-1 text-red-500 hover:text-red-700"
                                onClick={() =>
                                  fields.length === 1
                                    ? toast.error(
                                        "Need at least one field"
                                      )
                                    : setDeleteFieldIdx(globalIndex)
                                }
                              >
                                <Trash2 className="size-3.5" />
                                Remove
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Add field to this section */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full min-h-[40px] text-sm text-zinc-500 gap-1.5"
                    onClick={() => addField(group.section)}
                  >
                    <Plus className="size-3.5" />
                    Add field to {group.section}
                  </Button>
                </div>
              )}
            </div>
          );
        })}

        {/* Add new section */}
        <Button
          variant="outline"
          className="w-full min-h-[48px] text-base gap-2"
          onClick={() => addField()}
        >
          <Plus className="size-4" />
          Add Field
        </Button>
      </div>

      <Separator />

      {/* Save / Cancel */}
      <div className="flex gap-3">
        <Button
          className="flex-1 min-h-[52px] text-base gap-2"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="size-4" />
              {mode === "create" ? "Create Template" : "Save Changes"}
            </>
          )}
        </Button>
        <Button
          variant="outline"
          className="min-h-[52px] text-base gap-2"
          onClick={() => router.push("/templates")}
        >
          <X className="size-4" />
          Cancel
        </Button>
      </div>

      {/* Delete field confirmation */}
      <AlertDialog
        open={deleteFieldIdx !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFieldIdx(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this field?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteFieldIdx !== null &&
                `"${fields[deleteFieldIdx]?.label || `Field ${deleteFieldIdx + 1}`}" will be removed from the template.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-[44px] bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                if (deleteFieldIdx !== null) removeField(deleteFieldIdx);
              }}
            >
              Remove Field
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
