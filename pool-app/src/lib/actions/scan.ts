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

/** Check if a normalized (no spaces/symbols) string is only unit/qualifier text */
function isOnlyUnitText(s: string): boolean {
  if (!s) return true;
  return /^(?:ft|sqft|squarefeet|foot|feet|gallons?|gal|inches?|in|meters?|m|yards?|yd|lbs?|lb|pounds?|pound|overall|interior|exterior|minimum|min|maximum|max|approx|approximate|est|estimated|total)*$/.test(s);
}

/**
 * Check if a child field is a fake duplicate of its parent.
 * A child is fake if, after stripping numbers and parentheticals,
 * it adds no new content beyond units/qualifiers.
 */
function isFakeChild(parentLabel: string, childLabel: string): boolean {
  const stripParens = (s: string) => s.replace(/\(.*?\)/g, "").trim();
  const parentClean = norm(stripParens(stripNumbering(parentLabel)));
  const childClean = norm(stripParens(stripNumbering(childLabel)));

  // Child is nothing but unit text (e.g., "ft", "sq ft")
  if (isOnlyUnitText(childClean)) return true;

  // Exact match after cleanup
  if (childClean === parentClean) return true;

  // Child is parent + units (e.g., parent "Pool Length", child "Pool Length ft")
  if (childClean.startsWith(parentClean)) {
    return isOnlyUnitText(childClean.slice(parentClean.length));
  }

  // Parent is child + units (child is abbreviated parent)
  if (parentClean.startsWith(childClean)) {
    return isOnlyUnitText(parentClean.slice(childClean.length));
  }

  return false;
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
    // "General" is not a real section — treat it as empty
    const isReal = (s?: string) => !!s?.trim() && s.trim().toLowerCase() !== "general";

    let lastSection = "";
    const repaired = fields.map((f) => {
      if (isReal(f.section)) {
        lastSection = f.section!.trim();
        return { ...f, section: lastSection };
      }
      // Fill gap with last-seen real section
      if (lastSection) {
        return { ...f, section: lastSection };
      }
      return f;
    });

    // Backward fill: numbered fields before the first real section
    // belong to that section, not "General"
    const firstSection = repaired.find(f => isReal(f.section))?.section;
    if (firstSection) {
      for (let i = 0; i < repaired.length; i++) {
        if (isReal(repaired[i].section)) break;
        if (leadingNumber(repaired[i].label) !== null) {
          repaired[i] = { ...repaired[i], section: firstSection };
        }
      }
    }

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

    // Backward fill: numbered fields before the first header → first section
    const firstSectionName = detectedSections[0]?.name;
    if (firstSectionName && repaired.length > 0) {
      for (let i = 0; i < repaired.length; i++) {
        const sec = repaired[i].section?.trim()?.toLowerCase();
        if (sec && sec !== "general") break;
        if (leadingNumber(repaired[i].label) !== null) {
          repaired[i] = { ...repaired[i], section: firstSectionName };
        }
      }
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
    if (sectionNorms.has(labelNorm)) {
      // Numbered fields like "4. Setbacks" are real questions even if
      // their label matches a section name — keep them
      return leadingNumber(f.label) !== null;
    }
    return true;
  });
}

// --- Pass 1: Clean up label artifacts ---

function cleanLabels(fields: RawField[]): RawField[] {
  return fields.map((f) => {
    let label = f.label;

    // Strip leading "[ ]" or "[x]" checkbox artifacts
    label = label.replace(/^\[\s*[xX]?\s*\]\s*/, "");

    // Strip trailing colons
    label = label.replace(/:\s*$/, "");

    // Fix truncated parentheses: "Spa Type Raised (" → "Spa Type Raised"
    label = label.replace(/\s*\(\s*$/, "");

    // Fix unmatched trailing paren: "something)" → "something"
    label = label.replace(/\)\s*$/, (match) => {
      // Only strip if there's no opening paren
      if (!label.includes("(")) return "";
      return match;
    });

    // Strip OCR underscores used as blanks: "Name ____" → "Name"
    label = label.replace(/[_]{2,}/g, "").trim();

    // Strip leading/trailing single underscores
    label = label.replace(/^_+|_+$/g, "");

    // Normalize whitespace
    label = label.trim().replace(/\s+/g, " ");

    if (label !== f.label) {
      return { ...f, label };
    }
    return f;
  });
}

// --- Pass 2b: Absorb option/note children back into parent ---
//
// Detects sub-numbered "children" that are actually option values or
// instructional notes, not real input fields. Examples:
//   "5a. Easements None (Check city plat map)" → note, not a field
//   "25a. Diving Board/Slide No (If yes, requires 8ft+ depth)" → note
//   "23a. Spa Type Raised" → option value, not a separate input
//
// Rule: if a child's stripped label is a single word or looks like
// Yes/No/None + optional parenthetical, it's an option/note.
// Absorb it as an option on the parent or drop it.

function absorbOptionChildren(fields: RawField[]): RawField[] {
  const result: RawField[] = [];
  let i = 0;

  while (i < fields.length) {
    const field = fields[i];
    const parentNum = leadingNumber(field.label);
    const parentSub = leadingSub(field.label);

    if (parentNum !== null && parentSub === null) {
      const parentSection = field.section || "";

      // Collect sub-children
      const children: RawField[] = [];
      let j = i + 1;
      while (j < fields.length) {
        const child = fields[j];
        if (
          leadingNumber(child.label) === parentNum &&
          leadingSub(child.label) !== null &&
          (child.section || "") === parentSection
        ) {
          children.push(child);
          j++;
        } else {
          break;
        }
      }

      if (children.length > 0) {
        // Check each child: is it a real input or an option/note?
        const realChildren: RawField[] = [];
        const absorbedOptions: string[] = [];

        // Measurement/dimension terms are sub-fields, never options
        const MEASUREMENT_WORDS = new Set([
          "length", "width", "height", "depth", "diameter",
          "area", "volume", "weight", "distance", "size",
        ]);

        for (const child of children) {
          const childText = stripNumbering(child.label);
          const bareText = childText.replace(/\(.*\)/, "").trim().toLowerCase();

          // Never absorb measurement sub-fields
          if (MEASUREMENT_WORDS.has(bareText)) {
            realChildren.push(child);
            continue;
          }

          // Pattern: starts with Yes/No/None + optional parenthetical
          const isYesNoNone = /^(yes|no|none|n\/a)\b/i.test(childText);

          // Pattern: contains instructional text like "If yes", "Check", "requires"
          const isInstruction = /\b(if\s+yes|if\s+no|check|requires|must|see|refer)\b/i.test(childText);

          // Only absorb unambiguous option/note patterns — never guess on single words
          // like "House" or "Fence" which are real sub-field names
          if (isYesNoNone || isInstruction) {
            // This is an option or note — absorb into parent
            const cleanOption = childText.replace(/\s*\(.*\)\s*$/, "").trim();
            if (cleanOption) absorbedOptions.push(cleanOption);
          } else {
            realChildren.push(child);
          }
        }

        // If we absorbed options, add them to parent
        if (absorbedOptions.length > 0) {
          const existingOptions = Array.isArray(field.options) ? field.options : [];
          const mergedOptions = [...existingOptions, ...absorbedOptions];
          result.push({ ...field, options: mergedOptions });
        } else {
          result.push(field);
        }

        // Emit real children (they'll be processed by merge pass next)
        result.push(...realChildren);
        i = j;
        continue;
      }
    }

    result.push(field);
    i++;
  }

  return result;
}

// --- Pass 4: Drop fake/unit children + deduplicate siblings ---
//
// HARD RULES (from user):
// 1. Never create child fields from units/help text (ft, sq ft, gallons, overall, etc.)
// 2. Only keep children that add genuine new content vs the parent
// 3. Deduplicate siblings with identical normalized labels (e.g., two "Sun Shelf Depth")
// 4. Valid grouped children (4a/4b/4c Setbacks) survive — they have new content words
// 5. "Depth" is allowed when tied to a real parent (Sun Shelf Depth)

function dropFakeChildren(fields: RawField[]): RawField[] {
  const result: RawField[] = [];
  let i = 0;

  while (i < fields.length) {
    const field = fields[i];
    const parentNum = leadingNumber(field.label);
    const parentSub = leadingSub(field.label);

    if (parentNum !== null && parentSub === null) {
      // Collect consecutive sub-children (ignore section — AI is unreliable)
      const children: RawField[] = [];
      let j = i + 1;
      while (j < fields.length) {
        const child = fields[j];
        if (
          leadingNumber(child.label) === parentNum &&
          leadingSub(child.label) !== null
        ) {
          children.push(child);
          j++;
        } else {
          break;
        }
      }

      result.push(field); // always keep parent

      if (children.length > 0) {
        const seenNorms = new Set<string>();

        for (const child of children) {
          // Drop unit/duplicate children via denylist
          if (isFakeChild(field.label, child.label)) continue;

          // Deduplicate siblings by normalized stripped label
          const cn = norm(stripNumbering(child.label));
          if (seenNorms.has(cn)) continue;
          seenNorms.add(cn);

          result.push(child);
        }

        i = j;
        continue;
      }
    }

    result.push(field);
    i++;
  }

  return result;
}

// --- Pass 2c: Merge compound/grouped fields (conservative) ---
//
// ONLY merges when the AI produced ≥2 explicit sub-numbered children:
//   "1. Total Yard Dimensions" + "1a. Length" + "1b. Width"
//   → children get contextual labels like "1a. Total Yard Dimensions — Length"
//
// A single child is NOT enough to trigger a merge (handled by dropFakeChildren).

function mergeCompoundFields(fields: RawField[]): RawField[] {
  const result: RawField[] = [];
  let i = 0;

  while (i < fields.length) {
    const field = fields[i];
    const parentNum = leadingNumber(field.label);
    const parentSub = leadingSub(field.label);

    if (parentNum !== null && parentSub === null) {
      const parentText = stripNumbering(field.label);
      const parentSection = field.section;

      const children: RawField[] = [];
      let j = i + 1;

      while (j < fields.length) {
        const child = fields[j];
        const childNum = leadingNumber(child.label);
        const childSub = leadingSub(child.label);

        // Match on number only — section assignment from AI is unreliable
        if (childNum === parentNum && childSub !== null) {
          children.push(child);
          j++;
          continue;
        }
        break;
      }

      // REQUIRE ≥2 children to trigger merge
      if (children.length >= 2) {
        // Special case: dimension pair (Length + Width) → single field
        if (children.length === 2) {
          const texts = children.map(c => stripNumbering(c.label).toLowerCase());
          const hasLength = texts.some(t => /\blength\b/.test(t));
          const hasWidth = texts.some(t => /\bwidth\b/.test(t));
          if (hasLength && hasWidth) {
            result.push({
              ...field,
              type: "text" as const,
              placeholder: "__ ft x __ ft",
              section: parentSection,
            });
            i = j;
            continue;
          }
        }

        // Decide: consume the parent or keep it?
        // If the parent is itself answerable (checkbox, radio, select,
        // or has options), keep it alongside children.
        // If parent is a pure heading/grouping label (text with no
        // options, no placeholder), consume it — it adds no input value.
        const ANSWERABLE_TYPES = new Set(["checkbox", "radio", "select"]);
        const parentIsAnswerable =
          ANSWERABLE_TYPES.has(field.type) ||
          (Array.isArray(field.options) && field.options.length > 0);

        if (parentIsAnswerable) {
          // Keep parent as its own field, emit children after it
          result.push(field);
        }
        // else: parent consumed (not emitted)

        for (const child of children) {
          const childText = stripNumbering(child.label);
          const existingSub = leadingSub(child.label)!;

          result.push({
            ...child,
            label: `${parentNum}${existingSub}. ${childText}`,
            section: parentSection, // Force parent section — AI assignment unreliable
          });
        }
        i = j;
        continue;
      }
    }

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

// --- Pass 5b: Fix child section assignment ---
//
// AI sometimes assigns children to a different section than their parent.
// This ensures every sub-lettered child (e.g., "20a.") inherits the section
// of its parent (e.g., "20.") so fixNumbering sorts them together.

function fixChildSections(fields: RawField[]): RawField[] {
  const parentSections = new Map<number, string>();
  for (const f of fields) {
    const num = leadingNumber(f.label);
    const sub = leadingSub(f.label);
    if (num !== null && sub === null && f.section) {
      parentSections.set(num, f.section);
    }
  }

  return fields.map(f => {
    const num = leadingNumber(f.label);
    const sub = leadingSub(f.label);
    if (num !== null && sub !== null) {
      const parentSection = parentSections.get(num);
      if (parentSection && f.section !== parentSection) {
        return { ...f, section: parentSection };
      }
    }
    return f;
  });
}

// --- Pass 5c: Clean child labels — strip repeated parent text ---
//
// If a child label starts with or contains the parent's text, strip it
// for cleaner display. Examples:
//   "4a. Setbacks House" → "4a. House"     (parent prefix stripped)
//   "20a. Sun Shelf Depth" → "20a. Depth"  (parent prefix stripped)
//   "4a. House Setback" → "4a. House"      (parent word stripped from end)

function cleanChildLabels(fields: RawField[]): RawField[] {
  // Build map of parent number → parent stripped text
  const parentTexts = new Map<number, string>();
  for (const f of fields) {
    const num = leadingNumber(f.label);
    const sub = leadingSub(f.label);
    if (num !== null && sub === null) {
      parentTexts.set(num, stripNumbering(f.label));
    }
  }

  return fields.map(f => {
    const num = leadingNumber(f.label);
    const sub = leadingSub(f.label);
    if (num === null || sub === null) return f;

    const parentText = parentTexts.get(num);
    if (!parentText) return f;

    const childText = stripNumbering(f.label);
    let clean = childText;

    // Strip parent text from beginning (e.g., "Setbacks House" → "House")
    if (clean.toLowerCase().startsWith(parentText.toLowerCase())) {
      clean = clean.slice(parentText.length).replace(/^[-—–,\s]+/, "").trim();
    }

    // Strip parent words from end (e.g., "House Setback" → "House")
    for (const pw of parentText.toLowerCase().split(/\s+/).filter(w => w.length > 2)) {
      const base = pw.replace(/s$/, "");
      clean = clean.replace(new RegExp(`\\s+${base}s?$`, 'i'), "").trim();
    }

    // Fallback to original if stripping left nothing
    if (!clean) return f;
    if (clean === childText) return f;

    return { ...f, label: `${num}${sub}. ${clean}` };
  });
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
  fields = cleanLabels(fields);                        // 1. strip [ ], trailing colons, truncated parens
  fields = dropSectionHeaderFields(fields, sections);  // 2. remove header dupes
  fields = absorbOptionChildren(fields);               // 3. absorb Yes/No/None + instructional text
  fields = dropFakeChildren(fields);                   // 4. kill unit/dupe children, keep real ones (4a/4b/4c)
  fields = mergeCompoundFields(fields);                // 5. group ≥2 children under parent + dimension collapse
  fields = fixChildSections(fields);                   // 6. ensure children share parent's section
  fields = cleanChildLabels(fields);                   // 7. strip repeated parent text from child labels
  fields = repairCheckboxes(fields);                   // 8. fix empty checkboxes
  fields = extractHelperText(fields);                  // 9. notes → placeholders
  fields = fixNumbering(fields);                       // 10. sort by number (children under parent)

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
