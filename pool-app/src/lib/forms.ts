import { z } from "zod";

// --- Field types supported by the form renderer ---

export type FieldType = "text" | "number" | "checkbox" | "select" | "textarea";

export type FormField = {
  id: string; // stable key, used in formData JSON and localStorage
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string; // text, number, textarea
  options?: string[]; // select only
};

export type FormTemplate = {
  id: string;
  name: string;
  version: number;
  fields: FormField[];
};

// --- Form data shape: field ID → string value or boolean (checkbox) ---

export type FormData = Record<string, string | boolean>;

// --- Build a Zod schema dynamically from a template ---

export function buildFormSchema(template: FormTemplate) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of template.fields) {
    switch (field.type) {
      case "text":
      case "textarea":
        shape[field.id] = field.required
          ? z.string().min(1, `${field.label} is required`)
          : z.string();
        break;

      case "number":
        if (field.required) {
          shape[field.id] = z
            .string()
            .min(1, `${field.label} is required`)
            .regex(/^\d+\.?\d*$/, `${field.label} must be a number`);
        } else {
          // Allow empty string or valid number
          shape[field.id] = z
            .string()
            .regex(/^(\d+\.?\d*)?$/, `${field.label} must be a number`);
        }
        break;

      case "checkbox":
        shape[field.id] = z.boolean();
        break;

      case "select":
        if (field.required) {
          shape[field.id] = z.string().min(1, `${field.label} is required`);
        } else {
          shape[field.id] = z.string();
        }
        break;
    }
  }

  return z.object(shape);
}

// --- Default values for a template (empty form) ---

export function getDefaultValues(template: FormTemplate): FormData {
  const defaults: FormData = {};
  for (const field of template.fields) {
    defaults[field.id] = field.type === "checkbox" ? false : "";
  }
  return defaults;
}

// --- Default pool installation template (hand-coded for MVP) ---

export const DEFAULT_TEMPLATE: FormTemplate = {
  id: "pool-install-v1",
  name: "Pool Installation",
  version: 1,
  fields: [
    {
      id: "customer_name",
      label: "Customer Name",
      type: "text",
      required: true,
      placeholder: "e.g., John Smith",
    },
    {
      id: "address",
      label: "Job Address",
      type: "text",
      required: true,
      placeholder: "e.g., 123 Main St, Anytown",
    },
    {
      id: "pool_type",
      label: "Pool Type",
      type: "select",
      required: true,
      options: ["Inground", "Above Ground", "Semi-Inground"],
    },
    {
      id: "pool_shape",
      label: "Pool Shape",
      type: "select",
      required: false,
      options: [
        "Rectangular",
        "Oval",
        "Round",
        "Freeform",
        "L-Shaped",
        "Kidney",
      ],
    },
    {
      id: "length",
      label: "Length (ft)",
      type: "number",
      required: true,
      placeholder: "e.g., 32",
    },
    {
      id: "width",
      label: "Width (ft)",
      type: "number",
      required: true,
      placeholder: "e.g., 16",
    },
    {
      id: "depth_shallow",
      label: "Depth - Shallow End (ft)",
      type: "number",
      required: false,
      placeholder: "e.g., 3.5",
    },
    {
      id: "depth_deep",
      label: "Depth - Deep End (ft)",
      type: "number",
      required: false,
      placeholder: "e.g., 8",
    },
    {
      id: "has_pump",
      label: "Pump Installed",
      type: "checkbox",
      required: false,
    },
    {
      id: "has_filter",
      label: "Filter Installed",
      type: "checkbox",
      required: false,
    },
    {
      id: "has_heater",
      label: "Heater Installed",
      type: "checkbox",
      required: false,
    },
    {
      id: "has_lights",
      label: "Lights Installed",
      type: "checkbox",
      required: false,
    },
    {
      id: "notes",
      label: "Notes",
      type: "textarea",
      required: false,
      placeholder: "Any additional details about the installation...",
    },
  ],
};
