"use server";

import { generateText, Output, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
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

export type PageScanResult = {
  success: boolean;
  fields: FormField[];
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

const PAGE_TIMEOUT_MS = 30_000;

// --- Model resolution: Gemini → Ollama → Mock ---

type ResolvedModel = {
  model: LanguageModel;
  provider: "gemini" | "ollama";
} | null;

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma3:4b";

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveModel(): Promise<ResolvedModel> {
  if (process.env.USE_MOCK_FORM_SCAN === "true") return null;

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return { model: google("gemini-2.5-flash-lite"), provider: "gemini" };
  }

  if (await isOllamaRunning()) {
    const ollama = createOpenAI({
      baseURL: `${OLLAMA_BASE}/v1`,
      apiKey: "ollama",
    });
    return { model: ollama(OLLAMA_MODEL), provider: "ollama" };
  }

  return null;
}

export async function isMockMode(): Promise<boolean> {
  return (await resolveModel()) === null;
}

// --- Validation ---

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

// --- Core extraction (single image, with timeout) ---

async function extractSingleImage(
  resolved: ResolvedModel & {},
  imageBase64: string,
  mimeType: string
): Promise<{ extracted: ExtractedTemplate | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

  try {
    const result = await generateText({
      model: resolved.model,
      output: Output.object({ schema: ExtractedTemplateSchema }),
      abortSignal: controller.signal,
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

    return { extracted: result.output as ExtractedTemplate | null };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { extracted: null, error: "timeout" };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { extracted: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// --- Core extraction (PDF, with timeout) ---

async function extractPdf(
  resolved: ResolvedModel & {},
  pdfBase64: string
): Promise<{ extracted: ExtractedTemplate | null; error?: string }> {
  const controller = new AbortController();
  // PDFs get more time — up to 60s
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS * 2);

  try {
    const result = await generateText({
      model: resolved.model,
      output: Output.object({ schema: ExtractedTemplateSchema }),
      abortSignal: controller.signal,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the structure of this blank paper form into a digital template. This PDF may have multiple pages. Return ALL fields from ALL pages in order.",
            },
            {
              type: "file",
              data: pdfBase64,
              mediaType: "application/pdf",
            },
          ],
        },
      ],
    });

    return { extracted: result.output as ExtractedTemplate | null };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { extracted: null, error: "timeout" };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { extracted: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// --- Public: single-page fast path ---

export async function extractFormTemplate(
  imageBase64: string,
  mimeType: string = "image/jpeg"
): Promise<ScanResult> {
  const resolved = await resolveModel();

  if (!resolved) {
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

  const { extracted, error } = await extractSingleImage(
    resolved,
    imageBase64,
    mimeType
  );

  if (error === "timeout") {
    return {
      success: false,
      error: "Scan timed out after 30 seconds. Try a clearer photo or upload as PDF.",
    };
  }
  if (error) {
    return { success: false, error: `AI extraction failed: ${error}` };
  }
  if (!extracted || !extracted.fields || extracted.fields.length === 0) {
    return {
      success: false,
      error: "Could not extract any fields from this image. Try a clearer photo.",
    };
  }

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
}

// --- Public: single page scan (for multi-page progress tracking) ---

export async function extractSinglePage(
  imageBase64: string,
  mimeType: string = "image/jpeg"
): Promise<PageScanResult> {
  const resolved = await resolveModel();
  if (!resolved) {
    return { success: false, fields: [], error: "No AI provider available" };
  }

  const { extracted, error } = await extractSingleImage(
    resolved,
    imageBase64,
    mimeType
  );

  if (error === "timeout") {
    return { success: false, fields: [], error: "timeout" };
  }
  if (error) {
    return { success: false, fields: [], error };
  }
  if (!extracted || !extracted.fields || extracted.fields.length === 0) {
    return { success: false, fields: [], error: "No fields found on this page" };
  }

  return { success: true, fields: validateExtractedFields(extracted) };
}

// --- Public: PDF extraction ---

export async function extractFormFromPdf(
  pdfBase64: string
): Promise<ScanResult> {
  const resolved = await resolveModel();

  if (!resolved) {
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

  const { extracted, error } = await extractPdf(resolved, pdfBase64);

  if (error === "timeout") {
    return {
      success: false,
      error: "PDF scan timed out after 60 seconds. Try uploading individual page photos instead.",
    };
  }
  if (error) {
    return { success: false, error: `AI extraction failed: ${error}` };
  }
  if (!extracted || !extracted.fields || extracted.fields.length === 0) {
    return {
      success: false,
      error: "Could not extract any fields from this PDF.",
    };
  }

  const fields = validateExtractedFields(extracted);
  if (fields.length === 0) {
    return {
      success: false,
      error: "AI returned fields but none were valid.",
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
}
