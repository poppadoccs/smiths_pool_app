"use client";

import { useState, useCallback } from "react";
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
  GripVertical,
  ChevronUp,
  ChevronDown,
  Loader2,
  Save,
  X,
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

function makeEmptyField(order: number): FormField {
  return {
    id: `field_${Date.now()}_${order}`,
    label: "",
    type: "text",
    required: false,
    order,
  };
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
    initialFields.length > 0
      ? initialFields
      : [makeEmptyField(0)]
  );
  const [saving, setSaving] = useState(false);
  const [deleteFieldIdx, setDeleteFieldIdx] = useState<number | null>(null);

  const addField = useCallback(() => {
    setFields((prev) => [...prev, makeEmptyField(prev.length)]);
  }, []);

  const removeField = useCallback((index: number) => {
    setFields((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.map((f, i) => ({ ...f, order: i }));
    });
    setDeleteFieldIdx(null);
  }, []);

  const moveField = useCallback((index: number, direction: "up" | "down") => {
    setFields((prev) => {
      const next = [...prev];
      const targetIdx = direction === "up" ? index - 1 : index + 1;
      if (targetIdx < 0 || targetIdx >= next.length) return prev;
      [next[index], next[targetIdx]] = [next[targetIdx], next[index]];
      return next.map((f, i) => ({ ...f, order: i }));
    });
  }, []);

  const updateField = useCallback(
    (index: number, updates: Partial<FormField>) => {
      setFields((prev) =>
        prev.map((f, i) => {
          if (i !== index) return f;
          const updated = { ...f, ...updates };
          // Auto-generate stable ID from label when label changes
          if (updates.label !== undefined && updates.label.trim()) {
            updated.id = generateFieldId(updates.label);
          }
          // Clear options when switching away from select/radio
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

    // Ensure unique IDs
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
    <div className="space-y-6">
      {/* Template info */}
      <Card>
        <CardContent className="p-4 space-y-4">
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
            <Textarea
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this form for?"
              className="min-h-[72px] text-base"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-cat" className="text-base">
              Category
            </Label>
            <Input
              id="tpl-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g., Inspection, Installation"
              className="min-h-[48px] text-base"
            />
          </div>
        </CardContent>
      </Card>

      {/* Fields */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-900">
          Fields ({fields.length})
        </h2>

        {fields.map((field, index) => (
          <Card key={`field-${index}`}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <GripVertical className="size-4" />
                  <span>Field {index + 1}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-9 p-0"
                    disabled={index === 0}
                    onClick={() => moveField(index, "up")}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-9 p-0"
                    disabled={index === fields.length - 1}
                    onClick={() => moveField(index, "down")}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-9 p-0 text-red-500 hover:text-red-700"
                    onClick={() =>
                      fields.length === 1
                        ? toast.error("Need at least one field")
                        : setDeleteFieldIdx(index)
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              {/* Label */}
              <div className="space-y-1">
                <Label className="text-sm">Label</Label>
                <Input
                  value={field.label}
                  onChange={(e) =>
                    updateField(index, { label: e.target.value })
                  }
                  placeholder="e.g., Customer Name"
                  className="min-h-[44px] text-base"
                />
              </div>

              {/* Type + Required row */}
              <div className="flex gap-3 items-end">
                <div className="flex-1 space-y-1">
                  <Label className="text-sm">Type</Label>
                  <Select
                    value={field.type}
                    onValueChange={(val) =>
                      updateField(index, { type: val as FieldType })
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
                    id={`req-${index}`}
                    checked={field.required}
                    onCheckedChange={(checked) =>
                      updateField(index, { required: !!checked })
                    }
                    className="size-5"
                  />
                  <Label
                    htmlFor={`req-${index}`}
                    className="text-sm cursor-pointer"
                  >
                    Required
                  </Label>
                </div>
              </div>

              {/* Placeholder */}
              {["text", "textarea", "number", "phone", "email", "date"].includes(
                field.type
              ) && (
                <div className="space-y-1">
                  <Label className="text-sm">Placeholder</Label>
                  <Input
                    value={field.placeholder || ""}
                    onChange={(e) =>
                      updateField(index, { placeholder: e.target.value })
                    }
                    placeholder="Hint text..."
                    className="min-h-[40px] text-sm"
                  />
                </div>
              )}

              {/* Options for select/radio */}
              {(field.type === "select" || field.type === "radio") && (
                <div className="space-y-1">
                  <Label className="text-sm">
                    Options (one per line)
                  </Label>
                  <Textarea
                    value={(field.options || []).join("\n")}
                    onChange={(e) =>
                      updateField(index, {
                        options: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder={"Option A\nOption B\nOption C"}
                    className="min-h-[80px] text-sm"
                  />
                </div>
              )}

              {/* Section grouping */}
              <div className="space-y-1">
                <Label className="text-sm">Section (optional)</Label>
                <Input
                  value={field.section || ""}
                  onChange={(e) =>
                    updateField(index, { section: e.target.value })
                  }
                  placeholder="e.g., Equipment"
                  className="min-h-[40px] text-sm"
                />
              </div>
            </CardContent>
          </Card>
        ))}

        <Button
          variant="outline"
          className="w-full min-h-[48px] text-base gap-2"
          onClick={addField}
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
