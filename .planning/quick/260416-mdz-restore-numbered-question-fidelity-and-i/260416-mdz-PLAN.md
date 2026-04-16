---
quick_id: 260416-mdz
description: restore numbered question fidelity and inline photo placement in PDF
date: 2026-04-16
status: ready
must_haves:
  truths:
    - PDF labels show full numbered question text (e.g. "1. Inspection performed for" not just "Inspection performed for")
    - Q1-Q5 have no section header (clean numbered list, no "4. TYPE OF INSTALLATION:" appearing before Q1)
    - Q6+ use clean descriptive section names without question numbers
    - Q4 options match paper exactly — Pool / Spa / Pool/Spa Combo (Shared) / Pool/Spa Combo (Dual)
    - Photo fields embed the actual image inline below the question label in the PDF
    - Photo Appendix shows only photos not already embedded inline
    - DB template updated — changes persist across all new jobs using Pool/Spa Inspection template
  artifacts:
    - pool-app/src/lib/actions/generate-pdf.ts (modified)
    - pool-app/scripts/fix-template-sections.ts (new — run once against DB)
---

# Quick Task 260416-mdz: Restore Numbered Question Fidelity + Inline Photos

## Root Causes

1. **DB template has corrupted sections** — AI extraction used the first question in each group as
   the section name. Result: Q1–Q5 all have `section: "4. Type of Installation:"`, so that
   numbered label renders as a bold section heading *before* Q1. Q5 and Q8 appear "missing"
   because they're visually buried under these wrong headings.

2. **PDF strips question numbers** — `generate-pdf.ts` line ~156 does
   `field.label.replace(/^\d+\.\s*/, "")` which strips "1." from all labels.

3. **Photo fields show "(photo attached)"** instead of fetching and embedding the actual image.

## Task 1: Fix generate-pdf.ts — preserve numbers + inline photos

**File:** `pool-app/src/lib/actions/generate-pdf.ts`

### Change 1: Add inlinePhotoUrls set before the field loop

Find this block (around line 127-129):
```typescript
// --- Form fields ---
doc.setFontSize(10);
let currentSection = "";
```

Add after it:
```typescript
const inlinePhotoUrls = new Set<string>();
```

### Change 2: Restructure the field loop

The existing field loop body (approximately lines 144–183) handles all fields the same way.
Replace the **entire body after the section header block** with the new code below.

The section header block (keep unchanged):
```typescript
// Section header
if (field.section && field.section !== currentSection) {
  currentSection = field.section;
  y += 3;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(field.section, MARGIN, y);
  y += 1;
  doc.setLineWidth(0.2);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 5;
}
```

**Replace** the block from `const rawValue = formData?.[field.id];` to `y += blockHeight;`
(the entire non-section-header portion of the loop body) with:

```typescript
    // Field label + value
    const rawValue = formData?.[field.id];

    // --- Photo fields: embed inline ---
    if (field.type === "photo") {
      const photoUrl =
        typeof rawValue === "string" && rawValue.startsWith("http")
          ? rawValue
          : null;
      if (photoUrl) inlinePhotoUrls.add(photoUrl);

      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      const photoLabelLines = doc.splitTextToSize(field.label, CONTENT_WIDTH);

      if (photoUrl) {
        try {
          const res = await fetch(photoUrl);
          const buf = await res.arrayBuffer();
          const b64 = Buffer.from(buf).toString("base64");
          const imgProps = doc.getImageProperties(b64);
          let imgH = (imgProps.height / imgProps.width) * CONTENT_WIDTH;
          if (imgH > 120) imgH = 120;

          const blockH = photoLabelLines.length * 4 + 3 + imgH + 8;
          if (y + blockH > 280) {
            doc.addPage();
            y = MARGIN;
          }
          doc.text(photoLabelLines, MARGIN, y);
          y += photoLabelLines.length * 4 + 3;
          doc.addImage(b64, "JPEG", MARGIN, y, CONTENT_WIDTH, imgH, undefined, "FAST");
          y += imgH + 8;
          continue;
        } catch {
          // fall through to text fallback
        }
      }

      // No URL or fetch failed — render as text
      const fallbackLines = doc.splitTextToSize(
        rawValue ? "(photo attached)" : "—",
        CONTENT_WIDTH - 85,
      );
      const photoBlockH =
        Math.max(photoLabelLines.length, fallbackLines.length) * 4 + 2;
      if (y + photoBlockH > 280) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(photoLabelLines, MARGIN, y);
      doc.setFont("helvetica", "normal");
      doc.text(fallbackLines, MARGIN + 85, y);
      y += photoBlockH;
      continue;
    }

    // --- Non-photo fields ---
    let displayValue: string;
    if (field.type === "checkbox") {
      displayValue = rawValue ? "Yes" : "No";
    } else if (typeof rawValue === "string" && rawValue.trim()) {
      displayValue = rawValue;
    } else {
      displayValue = "—";
    }

    const label = field.label; // preserve question numbering — do NOT strip
    const labelWidth = 80;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);

    // Pre-measure wrapped text to check page break BEFORE drawing
    const labelLines = doc.splitTextToSize(label, labelWidth);
    doc.setFont("helvetica", "normal");
    const valueLines = doc.splitTextToSize(
      displayValue,
      CONTENT_WIDTH - labelWidth - 5,
    );
    const blockHeight = Math.max(labelLines.length, valueLines.length) * 4 + 2;

    if (y + blockHeight > 280) {
      doc.addPage();
      y = MARGIN;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(labelLines, MARGIN, y);

    doc.setFont("helvetica", "normal");
    doc.text(valueLines, MARGIN + labelWidth + 5, y);

    y += blockHeight;
```

### Change 3: Filter Photo Appendix to exclude inline photos

Find this line (around line 226):
```typescript
  const photos = job.photos as PhotoMetadata[] | null;
```

Replace with:
```typescript
  const allPhotos = job.photos as PhotoMetadata[] | null;
  const photos = allPhotos?.filter((p) => !inlinePhotoUrls.has(p.url)) ?? null;
```

## Task 2: Write and run fix-template-sections.ts

### Write the script

**File:** `pool-app/scripts/fix-template-sections.ts`

```typescript
/**
 * Fixes corrupted section assignments in the Pool/Spa Inspection template.
 * The AI extraction used numbered question labels as section names (e.g., Q1–Q5
 * were all assigned section "4. Type of Installation:"). This script replaces
 * all section values with clean descriptive names keyed by question order.
 *
 * Usage: npx tsx scripts/fix-template-sections.ts
 */
import { loadEnvConfig } from "@next/env";
import { resolve } from "path";
loadEnvConfig(resolve(__dirname, ".."));

import { readFileSync } from "fs";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaNeon } from "@prisma/adapter-neon";

// Section mapping by question order range (inclusive)
// Orders 0–4 (Q1–Q5) get no section — clean numbered list at the top
const SECTION_RANGES: Array<[number, number, string | undefined]> = [
  [0,   4,   undefined],            // Q1–Q5: no section
  [5,   15,  "Pool Pump"],
  [16,  16,  "Spa Pump"],
  [17,  25,  "Pool Filter"],
  [26,  26,  "Spa Filter"],
  [27,  32,  "Automation"],
  [33,  43,  "Sanitation"],
  [44,  49,  "Lighting"],
  [50,  59,  "Heating & Solar"],
  [60,  71,  "Valves"],
  [72,  75,  "Pool Deck"],
  [76,  82,  "Coping & Tile"],
  [83,  90,  "Skimmer & Drains"],
  [91,  96,  "Handrail & Ladder"],
  [97,  102, "Pool & Spa Finish"],
  [103, 107, "Additional"],
];

function sectionForOrder(order: number): string | undefined {
  for (const [min, max, section] of SECTION_RANGES) {
    if (order >= min && order <= max) return section;
  }
  return undefined;
}

async function main() {
  const data = JSON.parse(
    readFileSync(resolve(__dirname, "extraction-output.json"), "utf-8"),
  );
  const sourceFields: Array<Record<string, unknown>> = data.template.fields;

  // Apply corrected sections
  const fixedFields = sourceFields.map((f) => {
    const section = sectionForOrder(f.order as number);
    // Build clean field — if section is undefined, omit the key entirely
    const { section: _old, ...rest } = f;
    return section !== undefined ? { ...rest, section } : rest;
  });

  const adapter = new PrismaNeon({
    connectionString: process.env.DATABASE_URL!,
  });
  const db = new PrismaClient({ adapter });

  try {
    const templates = await db.formTemplate.findMany({
      where: { name: "Pool/Spa Inspection" },
      select: { id: true, name: true },
    });

    if (templates.length === 0) {
      console.error("No 'Pool/Spa Inspection' template found in DB.");
      process.exit(1);
    }

    for (const t of templates) {
      await db.formTemplate.update({
        where: { id: t.id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { fields: fixedFields as any },
      });
      console.log(`Updated template ${t.id} — "${t.name}"`);
    }

    console.log(`Done. ${templates.length} template(s) updated.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
```

### Run the script

```bash
cd pool-app && npx tsx scripts/fix-template-sections.ts
```

Verify output: should print "Updated template <id> — 'Pool/Spa Inspection'" and "Done. 1 template(s) updated."

## Notes

- `continue` in `for...of` is valid TypeScript/JavaScript — no issues
- `inlinePhotoUrls` must be declared BEFORE the `for (const field of template.fields)` loop
- Photo Appendix title/description stay the same; only the filter changes
- The script reads field data from extraction-output.json (source of truth) so Q4 options
  are also verified correct: Pool / Spa / Pool/Spa Combo (Shared) / Pool/Spa Combo (Dual)
- If there are multiple "Pool/Spa Inspection" templates (from multiple script runs),
  ALL are updated — all jobs will get corrected sections
- The executor should NOT update DEFAULT_TEMPLATE in forms.ts (separate concern, not requested)
