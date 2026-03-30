"use server";

import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { FormField, FieldType } from "@/lib/forms";
import { getRandomMockTemplate } from "@/lib/mock-form-templates";

const FIELD_TYPE_VALUES: [FieldType, ...FieldType[]] = [
  "text",
  "textarea",
  "number",
  "date",
  "checkbox",
  "radio",
  "select",
  "phone",
  "email",
  "signature",
];

const ExtractedFieldSchema = z.object({
  label: z.string().describe("The field label as printed on the form"),
  type: z
    .enum(FIELD_TYPE_VALUES)
    .describe("Best guess at the field type based on context"),
  required: z
    .boolean()
    .describe("True if the field appears required (marked with * or bold)"),
  placeholder: z
    .string()
    .optional()
    .describe("Suggested placeholder text for the field"),
  options: z
    .array(z.string())
    .optional()
    .describe("Options list for radio/select/checkbox group fields"),
  section: z
    .string()
    .optional()
    .describe("Section heading this field belongs to, if detectable"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Confidence score 0-1 for this extraction"),
});

const ExtractedTemplateSchema = z.object({
  name: z
    .string()
    .describe("Title of the form, extracted from the header or top of the page"),
  description: z
    .string()
    .optional()
    .describe("Brief description of the form's purpose"),
  category: z
    .string()
    .optional()
    .describe("Category like Inspection, Installation, Service, etc."),
  fields: z
    .array(ExtractedFieldSchema)
    .describe("All form fields in order as they appear on the page"),
});

type ExtractedTemplate = z.infer<typeof ExtractedTemplateSchema>;

export type ScanResult = {
  success: boolean;
  mock?: boolean;
  template?: {
    name: string;
    description: string;
    category: string;
    fields: FormField[];
  };
  error?: string;
};

const SYSTEM_PROMPT = `You are a form structure extractor. You analyze photos of blank paper forms and extract their structure into a digital template.

Rules:
- Extract EVERY visible field on the form, in order from top to bottom, left to right
- Guess the best field type based on context (e.g., "Phone" → phone, "Date" → date, "Email" → email)
- If a field has checkboxes or radio buttons next to options, extract as radio or select with the options listed
- If a field has a large blank area, use textarea
- If a field is for a signature, use signature
- Mark fields as required if they have asterisks (*), "required" text, or are clearly mandatory
- Group fields into sections if the form has section headers
- Extract the form title from the header
- Set confidence based on how clearly you can read the field (1.0 = crystal clear, 0.5 = somewhat readable)
- Do NOT make up fields that aren't on the form
- Do NOT include page numbers, form numbers, or decorative elements as fields`;

/** Check if we're in mock mode (no API key or explicitly set) */
export function isMockMode(): boolean {
  if (process.env.USE_MOCK_FORM_SCAN === "true") return true;
  if (!process.env.OPENAI_API_KEY) return true;
  return false;
}

/** Validate and sanitize extracted fields server-side before returning */
function validateExtractedFields(raw: ExtractedTemplate): FormField[] {
  const validTypes = new Set(FIELD_TYPE_VALUES);

  return raw.fields
    .filter((f) => f.label && typeof f.label === "string" && f.label.trim())
    .map((f, index) => ({
      id:
        f.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "") || `field_${index}`,
      label: f.label.trim().slice(0, 200),
      type: validTypes.has(f.type) ? f.type : "text",
      required: typeof f.required === "boolean" ? f.required : false,
      placeholder: f.placeholder?.slice(0, 200),
      options: Array.isArray(f.options)
        ? f.options.filter((o) => typeof o === "string").map((o) => o.slice(0, 100))
        : undefined,
      section: f.section?.slice(0, 100),
      order: index,
    }));
}

export async function extractFormTemplate(
  imageBase64: string,
  mimeType: string = "image/jpeg"
): Promise<ScanResult> {
  // --- MOCK MODE: return realistic sample data, zero cost ---
  if (isMockMode()) {
    // Simulate network delay so the UI loading state is visible
    await new Promise((r) => setTimeout(r, 1500));

    const mock = getRandomMockTemplate();
    return {
      success: true,
      mock: true,
      template: {
        name: mock.name,
        description: mock.description,
        category: mock.category,
        fields: mock.fields,
      },
    };
  }

  // --- REAL AI MODE ---
  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      output: Output.object({ schema: ExtractedTemplateSchema }),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the structure of this blank paper form into a digital template. Return every field you can see, in order.",
            },
            {
              type: "image",
              image: imageBase64,
              mediaType: mimeType,
            },
          ],
        },
      ],
    });

    const extracted = result.output as ExtractedTemplate | undefined;
    if (!extracted || !extracted.fields || extracted.fields.length === 0) {
      return {
        success: false,
        error: "Could not extract any fields from this image. Try a clearer photo.",
      };
    }

    // Server-side validation of AI response
    const fields = validateExtractedFields(extracted);
    if (fields.length === 0) {
      return {
        success: false,
        error: "AI returned fields but none were valid. Try a clearer photo.",
      };
    }

    return {
      success: true,
      template: {
        name: (extracted.name || "Untitled Form").slice(0, 200),
        description: (extracted.description || "").slice(0, 500),
        category: (extracted.category || "").slice(0, 100),
        fields,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      success: false,
      error: `AI extraction failed: ${message}`,
    };
  }
}
