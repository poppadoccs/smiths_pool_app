import { z } from "zod";

// --- Field types supported by the form renderer ---

export type FieldType =
  | "text"
  | "number"
  | "checkbox"
  | "select"
  | "textarea"
  | "date"
  | "phone"
  | "email"
  | "radio"
  | "signature"
  | "photo";

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Long Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "checkbox", label: "Checkbox" },
  { value: "radio", label: "Radio (pick one)" },
  { value: "select", label: "Dropdown" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "signature", label: "Signature" },
  { value: "photo", label: "Photo" },
];

export type FormField = {
  id: string; // stable key, used in formData JSON and localStorage
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string; // text, number, textarea, phone, email
  options?: string[]; // select, radio
  section?: string; // group heading
  order: number;
};

export type FormTemplate = {
  id: string;
  name: string;
  version: number;
  fields: FormField[];
};

// --- Form data shape: field ID → value ---
//
// Widened to `unknown` so reserved `__`-prefixed keys (owned by dedicated
// server actions, never by RHF autosave) can coexist with template-field
// keys in the same bag. See plan 260417-mpf §Reserved keys.
//
// Reserved keys (all __-prefixed):
//   __photoAssignmentsByField  — Record<string, string[]>  (src/lib/multi-photo.ts)
//   __summary_items            — SummaryItem[]             (src/lib/summary.ts)
//   __photoAssignmentsReviewed — boolean                   (src/lib/actions/photo-assignments.ts)
//
// Template-field values at runtime are still `string | boolean` per the
// Zod schema in buildFormSchema. Consumers that need narrow types MUST
// use `typeof` guards or run values through the schema.
export type FormData = Record<string, unknown>;

// --- Build a Zod schema dynamically from a template ---

export function buildFormSchema(template: FormTemplate) {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of template.fields) {
    switch (field.type) {
      case "text":
      case "textarea":
      case "signature":
        shape[field.id] = field.required
          ? z.string().min(1, `${field.label} is required`)
          : z.string();
        break;

      case "phone":
        shape[field.id] = field.required
          ? z.string().min(1, `${field.label} is required`)
          : z.string();
        break;

      case "email":
        if (field.required) {
          shape[field.id] = z
            .string()
            .min(1, `${field.label} is required`)
            .email(`${field.label} must be a valid email`);
        } else {
          shape[field.id] = z
            .string()
            .refine(
              (val) => val === "" || z.string().email().safeParse(val).success,
              { message: `${field.label} must be a valid email` },
            );
        }
        break;

      case "date":
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
          shape[field.id] = z
            .string()
            .regex(/^(\d+\.?\d*)?$/, `${field.label} must be a number`);
        }
        break;

      case "checkbox":
        shape[field.id] = z.boolean();
        break;

      case "select":
      case "radio":
        if (field.required) {
          shape[field.id] = z.string().min(1, `${field.label} is required`);
        } else {
          shape[field.id] = z.string();
        }
        break;

      case "photo":
        // Photo fields store a URL or base64 string after upload
        shape[field.id] = field.required
          ? z.string().min(1, `${field.label} is required`)
          : z.string();
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
      order: 0,
    },
    {
      id: "address",
      label: "Job Address",
      type: "text",
      required: true,
      placeholder: "e.g., 123 Main St, Anytown",
      order: 1,
    },
    {
      id: "pool_type",
      label: "Pool Type",
      type: "select",
      required: true,
      options: ["Inground", "Above Ground", "Semi-Inground"],
      order: 2,
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
      order: 3,
    },
    {
      id: "length",
      label: "Length (ft)",
      type: "number",
      required: true,
      placeholder: "e.g., 32",
      order: 4,
    },
    {
      id: "width",
      label: "Width (ft)",
      type: "number",
      required: true,
      placeholder: "e.g., 16",
      order: 5,
    },
    {
      id: "depth_shallow",
      label: "Depth - Shallow End (ft)",
      type: "number",
      required: false,
      placeholder: "e.g., 3.5",
      order: 6,
    },
    {
      id: "depth_deep",
      label: "Depth - Deep End (ft)",
      type: "number",
      required: false,
      placeholder: "e.g., 8",
      order: 7,
    },
    {
      id: "has_pump",
      label: "Pump Installed",
      type: "checkbox",
      required: false,
      order: 8,
    },
    {
      id: "has_filter",
      label: "Filter Installed",
      type: "checkbox",
      required: false,
      order: 9,
    },
    {
      id: "has_heater",
      label: "Heater Installed",
      type: "checkbox",
      required: false,
      order: 10,
    },
    {
      id: "has_lights",
      label: "Lights Installed",
      type: "checkbox",
      required: false,
      order: 11,
    },
    {
      id: "notes",
      label: "Notes",
      type: "textarea",
      required: false,
      placeholder: "Any additional details about the installation...",
      order: 12,
    },
  ],
};
