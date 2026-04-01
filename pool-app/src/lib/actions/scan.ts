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

STRUCTURE PRESERVATION (critical):
- Preserve the EXACT section headers from the form (e.g., "I. SITE LOGISTICS & ACCESS", "II. POOL SPECIFICATIONS"). Set the "section" field to the full section header text for every field under that section.
- Preserve question numbering in the label. If the form says "3. Gate Code", the label must be "3. Gate Code", not just "Gate Code".
- Preserve the original order of fields within each section. Do not reorder, alphabetize, or group by type.

PARENT/CHILD FIELDS (critical):
- When a question has subfields (e.g., "5. Sun Shelf (Tanning Ledge)" with a "Depth" line below it), the subfield label must include the parent context: "5a. Sun Shelf Depth", NOT just "Depth".
- Child fields MUST appear immediately after their parent field in the output array. Never orphan a subfield away from its parent.
- If a question has multiple blanks or sub-answers (e.g., "Length ___ Width ___"), extract each as a separate field with contextual labels: "4a. Pool Length", "4b. Pool Width".

FIELD TYPE RULES:
- "Phone", "Ph", "Tel" → type: phone
- "Email", "E-mail" → type: email
- "Date", "DOB" → type: date
- Checkboxes or Yes/No → type: checkbox
- Radio buttons or pick-one options → type: radio (include all options)
- Dropdown or select-one from a list → type: select (include all options)
- Large blank area, multi-line, or "Notes"/"Comments" → type: textarea
- Signature line → type: signature
- Everything else → type: text
- Mark fields as required if they have asterisks (*), "required" text, or are clearly mandatory

OTHER RULES:
- Extract the form title from the header or top of the page
- Set confidence based on how clearly you can read the field (1.0 = crystal clear, 0.5 = somewhat readable)
- Do NOT make up fields that aren't on the form
- Do NOT include page numbers, form revision numbers, or decorative elements as fields
- Do NOT use generic labels like "Field 1" or "Text Input" — always use the actual text from the form`;

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
    const modelId = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
    return { model: google(modelId), provider: "gemini" };
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

// =====================================================================
// POST-EXTRACTION NORMALIZATION PIPELINE
// Runs after every AI extraction to repair structure issues.
// =====================================================================

type RawField = z.infer<typeof ExtractedFieldSchema>;

// --- Helpers ---

function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** Strip leading "1." or "1a." numbering from a label */
function stripNumbering(label: string): string {
  return label.replace(/^\d+[a-z]?\.\s*/, "").trim();
}

/** Extract the leading number from "3. Something" → 3 */
function leadingNumber(label: string): number | null {
  const m = label.match(/^(\d+)\./);
  return m ? parseInt(m[1]) : null;
}

/** Extract the leading sub-letter from "3a. Something" → "a" */
function leadingSub(label: string): string | null {
  const m = label.match(/^\d+([a-z])\./);
  return m ? m[1] : null;
}

/** Normalize a string for fuzzy matching (lowercase, alpha-numeric only) */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// --- Pass 0: Stabilize section assignment ---
//
// The AI is inconsistent with sections: sometimes it assigns them,
// sometimes it leaves fields in "General", sometimes it invents sections.
//
// Strategy:
// 1. Count how many fields have a non-empty section from the AI
// 2. If majority (>50%) have sections → trust the AI, fill gaps by
//    propagating the last-seen section forward
// 3. If minority have sections → don't trust them. Instead, detect
//    section-header-like fields (Roman numeral or all-caps labels with
//    no real input type) and use those as section boundaries
// 4. If no sections detectable at all → leave as "General" and flag
//    low confidence (caller can check this)

type SectionStabilizeResult = {
  fields: RawField[];
  sections: Set<string>;
  lowConfidenceSections: boolean;
};

function stabilizeSections(fields: RawField[]): SectionStabilizeResult {
  if (fields.length === 0) {
    return { fields, sections: new Set(), lowConfidenceSections: false };
  }

  const withSection = fields.filter((f) => f.section && f.section.trim());
  const ratio = withSection.length / fields.length;

  // Case 1: AI assigned sections to most fields — trust and fill gaps
  if (ratio > 0.5) {
    let lastSection = "";
    const repaired = fields.map((f) => {
      if (f.section && f.section.trim()) {
        lastSection = f.section.trim();
        return f;
      }
      // Fill gap with last-seen section
      if (lastSection) {
        return { ...f, section: lastSection };
      }
      return f;
    });

    const sections = new Set<string>();
    for (const f of repaired) {
      if (f.section) sections.add(f.section);
    }

    return { fields: repaired, sections, lowConfidenceSections: false };
  }

  // Case 2: Try to detect section headers from the fields themselves
  // Look for fields that match section-header patterns:
  // - Roman numeral prefix: "I.", "II.", "III.", "IV." etc.
  // - All-caps label with no real input (type=text, no placeholder)
  // - Label that looks like a header, not a question

  const ROMAN_PREFIX = /^[IVXLC]+\.\s+/i;

  const detectedSections: { index: number; name: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const label = fields[i].label.trim();
    if (ROMAN_PREFIX.test(label) && fields[i].type === "text" && !fields[i].placeholder) {
      detectedSections.push({ index: i, name: label });
    }
  }

  if (detectedSections.length > 0) {
    // Assign each field to the most recent detected section header
    const repaired: RawField[] = [];
    let currentSection = "";
    let headerIndices = new Set(detectedSections.map((s) => s.index));

    for (let i = 0; i < fields.length; i++) {
      if (headerIndices.has(i)) {
        currentSection = fields[i].label.trim();
        // Don't emit the header as a field — it becomes the section name
        continue;
      }
      repaired.push({
        ...fields[i],
        section: currentSection || fields[i].section,
      });
    }

    const sections = new Set<string>();
    for (const f of repaired) {
      if (f.section) sections.add(f.section);
    }

    return { fields: repaired, sections, lowConfidenceSections: false };
  }

  // Case 3: No reliable sections detected
  // Use whatever the AI gave us but flag as low confidence
  const sections = new Set<string>();
  for (const f of fields) {
    if (f.section) sections.add(f.section);
  }

  return {
    fields,
    sections,
    lowConfidenceSections: sections.size <= 1,
  };
}

// --- Pass 1: Drop section-header-as-field duplicates ---

function dropSectionHeaderFields(
  fields: RawField[],
  sections: Set<string>
): RawField[] {
  if (sections.size === 0) return fields;

  // Build normalized section names for matching
  const sectionNorms = new Set<string>();
  for (const sec of sections) {
    sectionNorms.add(norm(sec));
    // Also strip Roman numeral prefix: "I. SITE LOGISTICS" → "SITE LOGISTICS"
    const stripped = sec.replace(/^[IVXLC]+\.\s*/i, "");
    if (stripped.length > 3) sectionNorms.add(norm(stripped));
  }

  return fields.filter((f) => {
    const labelNorm = norm(stripNumbering(f.label));
    if (!labelNorm) return false;
    return !sectionNorms.has(labelNorm);
  });
}

// --- Pass 2: Merge compound/grouped fields (conservative) ---
//
// ONLY merges when the AI already produced explicit sub-numbered children:
//   "1. Total Yard Dimensions" + "1a. Length" + "1b. Width"
//   → children get contextual labels like "1a. Total Yard Dimensions — Length"
//
// Does NOT split or create new fields from single fields.
// Does NOT treat "(ft)", "(sq ft)", "(gallons)" as split signals.
// A field like "10. Length (Overall):" stays as ONE field.

function mergeCompoundFields(fields: RawField[]): RawField[] {
  const result: RawField[] = [];
  let i = 0;

  while (i < fields.length) {
    const field = fields[i];
    const parentNum = leadingNumber(field.label);
    const parentSub = leadingSub(field.label);

    // Only consider numbered parents WITHOUT a sub-letter
    if (parentNum !== null && parentSub === null) {
      const parentText = stripNumbering(field.label);
      const parentSection = field.section;

      // Look ahead ONLY for explicit sub-numbered children: "1a.", "1b.", etc.
      const children: RawField[] = [];
      let j = i + 1;

      while (j < fields.length) {
        const child = fields[j];
        const childNum = leadingNumber(child.label);
        const childSub = leadingSub(child.label);
        const sameSection =
          (child.section || "") === (parentSection || "");

        // Only pattern: explicit "1a.", "1b." with same parent number
        if (childNum === parentNum && childSub !== null && sameSection) {
          children.push(child);
          j++;
          continue;
        }

        // Any other field (different number, unnumbered, different section) → stop
        break;
      }

      if (children.length > 0) {
        // Parent consumed — emit children with contextual labels
        for (const child of children) {
          const childText = stripNumbering(child.label);
          const existingSub = leadingSub(child.label)!;

          // Add parent context if child label doesn't already include it
          const parentFirstWord = parentText.split(" ")[0].toLowerCase();
          const alreadyHasContext =
            childText.toLowerCase().includes(parentFirstWord);

          const contextLabel = alreadyHasContext
            ? `${parentNum}${existingSub}. ${childText}`
            : `${parentNum}${existingSub}. ${parentText} — ${childText}`;

          result.push({
            ...child,
            label: contextLabel,
            section: child.section || parentSection,
          });
        }
        i = j;
        continue;
      }
    }

    // No sub-numbered children → emit field as-is
    result.push(field);
    i++;
  }

  return result;
}

// --- Pass 3: Fix checkbox fields without options ---
// If a checkbox has no options, downgrade to text (an empty checkbox is useless).
// Also: if AI extracted a parent question as checkbox but the real choices
// are in child fields, the children should have been merged by pass 2.

function repairCheckboxes(fields: RawField[]): RawField[] {
  return fields.map((f) => {
    if (f.type === "checkbox") {
      const hasOptions =
        Array.isArray(f.options) && f.options.filter((o) => o.trim()).length > 0;
      if (!hasOptions) {
        // A single yes/no checkbox is valid — keep it
        // But if label suggests multiple choices, downgrade to text
        return f;
      }
    }
    // If type is radio/select but no options, downgrade to text
    if ((f.type === "radio" || f.type === "select") &&
        (!Array.isArray(f.options) || f.options.filter((o) => o.trim()).length === 0)) {
      return { ...f, type: "text" as const };
    }
    return f;
  });
}

// --- Pass 4: Extract helper text from labels into placeholders ---
//
// RULES:
// - "(e.g., 32 ft)" → move to placeholder (explicit example)
// - "(concrete, pavers, etc.)" → move to placeholder (example list)
// - "(ft)", "(Sq Ft)", "(Est. Gallons)" → KEEP in label, do NOT strip
//   These are units/qualifiers that clarify the question, not hints.
// - "(Overall)", "(Interior)" → KEEP in label, these are clarifiers

function extractHelperText(fields: RawField[]): RawField[] {
  return fields.map((f) => {
    let label = f.label;
    let placeholder = f.placeholder;

    // Pattern 1: "(e.g., ...)", "(ex: ...)", "(example: ...)", "(note: ...)"
    const hintMatch = label.match(
      /\s*\((?:e\.?g\.?|ex|example|hint|note)[:\s,.]*([^)]+)\)\s*$/i
    );
    if (hintMatch && !placeholder) {
      label = label.slice(0, hintMatch.index).trim();
      placeholder = hintMatch[1].trim();
    }

    // Pattern 2: "(concrete, pavers, etc.)" — example list with "etc."
    if (!placeholder) {
      const listMatch = label.match(/\s*\(([^)]*etc\.?)\)\s*$/i);
      if (listMatch) {
        label = label.slice(0, listMatch.index).trim();
        placeholder = `e.g., ${listMatch[1]}`;
      }
    }

    // NOTE: We intentionally do NOT strip unit parentheticals like
    // "(ft)", "(Sq Ft)", "(Est. Gallons)", "(Overall)" from labels.
    // These clarify what the field IS, not how to fill it.

    if (label !== f.label || placeholder !== f.placeholder) {
      return { ...f, label, placeholder };
    }
    return f;
  });
}

// --- Pass 5: Fix numbering —  preserve source numbers, sort within sections ---

function fixNumbering(fields: RawField[]): RawField[] {
  // Group by section preserving encounter order
  const sectionOrder: string[] = [];
  const groups = new Map<string, RawField[]>();

  for (const f of fields) {
    const sec = f.section || "__none__";
    if (!groups.has(sec)) {
      sectionOrder.push(sec);
      groups.set(sec, []);
    }
    groups.get(sec)!.push(f);
  }

  // Stable sort within each section by number, then sub-letter
  const result: RawField[] = [];
  for (const sec of sectionOrder) {
    const group = groups.get(sec)!;
    group.sort((a, b) => {
      const na = leadingNumber(a.label);
      const nb = leadingNumber(b.label);
      if (na !== null && nb !== null) {
        if (na !== nb) return na - nb;
        // Same number — parent (no sub) before children (with sub)
        const sa = leadingSub(a.label);
        const sb = leadingSub(b.label);
        if (!sa && sb) return -1;
        if (sa && !sb) return 1;
        if (sa && sb) return sa.localeCompare(sb);
      }
      // Numbered before unnumbered within same position
      if (na !== null && nb === null) return -1;
      if (na === null && nb !== null) return 1;
      return 0; // preserve AI order for unnumbered
    });
    result.push(...group);
  }

  return result;
}

// --- Pass 6: Final sanitization — dedupe IDs, validate types, assign order ---

function sanitizeFields(fields: RawField[]): FormField[] {
  const validTypes = new Set(FIELD_TYPE_VALUES);
  const seenIds = new Set<string>();

  return fields
    .filter((f) => f.label && typeof f.label === "string" && f.label.trim())
    .map((f, index) => {
      let id =
        f.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "") || `field_${index}`;

      let counter = 1;
      const baseId = id;
      while (seenIds.has(id)) {
        id = `${baseId}_${counter++}`;
      }
      seenIds.add(id);

      return {
        id,
        label: normalizeWhitespace(f.label).slice(0, 200),
        type: validTypes.has(f.type) ? f.type : "text",
        required: typeof f.required === "boolean" ? f.required : false,
        placeholder: f.placeholder?.trim().slice(0, 200),
        options: Array.isArray(f.options)
          ? f.options
              .filter((o) => typeof o === "string" && o.trim())
              .map((o) => o.trim().slice(0, 100))
          : undefined,
        section: f.section?.trim().slice(0, 100),
        order: index,
      };
    });
}

// --- Full pipeline ---

/** Conservative fallback — only sanitize, no structural changes */
function conservativeNormalize(raw: ExtractedTemplate): FormField[] {
  let fields = raw.fields;
  fields = repairCheckboxes(fields);
  fields = extractHelperText(fields);
  return sanitizeFields(fields);
}

const BLOAT_THRESHOLD = 0.30; // 30% — if pipeline adds more than this, fallback

function normalizeExtractedFields(raw: ExtractedTemplate): FormField[] {
  const rawCount = raw.fields.length;

  // Pass 0: Stabilize sections first
  const { fields: sectionStable, sections } = stabilizeSections(raw.fields);
  let fields = sectionStable;

  // Run remaining passes
  fields = dropSectionHeaderFields(fields, sections); // 1. remove header dupes
  fields = mergeCompoundFields(fields);               // 2. group parent/children
  fields = repairCheckboxes(fields);                   // 3. fix empty checkboxes
  fields = extractHelperText(fields);                  // 4. notes → placeholders
  fields = fixNumbering(fields);                       // 5. sort by number

  const result = sanitizeFields(fields);               // 6. dedupe + validate

  // Bloat guard
  if (rawCount > 0 && result.length > rawCount * (1 + BLOAT_THRESHOLD)) {
    console.warn(
      `[scan] Bloat guard: normalization produced ${result.length} fields from ${rawCount} raw (>${Math.round(BLOAT_THRESHOLD * 100)}% increase). Falling back to conservative pass.`
    );
    return conservativeNormalize(raw);
  }

  return result;
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

  const fields = normalizeExtractedFields(extracted);
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

  return { success: true, fields: normalizeExtractedFields(extracted) };
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

  const fields = normalizeExtractedFields(extracted);
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
