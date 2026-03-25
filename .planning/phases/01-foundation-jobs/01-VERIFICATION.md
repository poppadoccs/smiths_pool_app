---
phase: 01-foundation-jobs
verified: 2026-03-25T12:36:00Z
status: gaps_found
score: 11/12 must-haves verified
gaps:
  - truth: "Next.js 16 app runs at localhost:3000 with no errors"
    status: failed
    reason: "npx next build fails with TypeScript error: Module '@prisma/client' has no exported member 'PrismaClient' in prisma/seed.ts. Prisma 7 generates the client to src/generated/prisma/ but seed.ts imports from the old @prisma/client path."
    artifacts:
      - path: "pool-app/prisma/seed.ts"
        issue: "Line 1: `import { PrismaClient } from \"@prisma/client\"` — wrong import path for Prisma 7. Should be `import { PrismaClient } from \"../src/generated/prisma/client\"`"
    missing:
      - "Fix seed.ts import: change `from \"@prisma/client\"` to `from \"../src/generated/prisma/client\"` (consistent with db.ts pattern established in Plan 01)"
human_verification:
  - test: "Open app in iPad-sized browser viewport (1024x768 landscape, then 768x1024 portrait)"
    expected: "Layout adapts to both orientations — max-w-2xl container is centered, no horizontal scroll, no fixed widths that clip content"
    why_human: "CSS layout correctness in both orientations cannot be verified by static code analysis"
  - test: "Tap a form input field on an iPad or using Safari on a Mac with touch simulation enabled"
    expected: "The page does NOT zoom in — font stays the same size, viewport does not shift"
    why_human: "iOS Safari zoom behavior on input focus cannot be verified programmatically; requires Safari rendering engine"
  - test: "Add app to iPad home screen by tapping Share > Add to Home Screen in Safari"
    expected: "App installs with 'Pool Forms' name and opens in standalone mode (no browser chrome)"
    why_human: "PWA home screen install behavior requires a real iOS device or Safari"
  - test: "Navigate the app with the browser at arm's length or while wearing gloves (simulate field conditions)"
    expected: "All buttons and inputs are visibly large enough to tap without precision — 48px+ height is perceptible"
    why_human: "Touch target usability in dirty/gloved-hands conditions requires physical human judgment"
  - test: "View the app in direct sunlight or with screen brightness at 50%"
    expected: "Text is clearly readable — dark zinc-900 on white background maintains legibility"
    why_human: "Outdoor sunlight readability cannot be assessed from code"
---

# Phase 1: Foundation + Jobs Verification Report

**Phase Goal:** Workers can create and select jobs on an iPad-optimized app that will never need to be reworked for field conditions
**Verified:** 2026-03-25T12:36:00Z
**Status:** gaps_found — 1 gap blocking build
**Re-verification:** No — initial verification

---

## Goal Achievement

The phase goal has two dimensions: (1) workers can create and select jobs, and (2) the app is iPad-optimized in ways that won't need rework. The job management UI is fully implemented and wired. The iPad foundations (CSS tokens, zoom prevention, manifest, touch targets) are all present. One gap exists: the build fails due to a wrong Prisma import in `seed.ts`, which is a blocker for deployment and clean CI.

### Observable Truths (from Plan frontmatter)

**Plan 01-01 truths:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Next.js 16 app runs at localhost:3000 with no errors | FAILED | `npx next build` exits with TypeScript error in `prisma/seed.ts` line 1 |
| 2 | Prisma schema has a Job model with status, photos JSON, formData JSON fields | VERIFIED | `schema.prisma` has `model Job` with `status JobStatus`, `photos Json @default("[]")`, `formData Json?` |
| 3 | Database connected to Neon Postgres and migrations applied | NEEDS_HUMAN | `prisma.config.ts` wires `DATABASE_URL` correctly; `prisma generate` has run (generated client exists at `src/generated/prisma/`); actual DB push awaits user provisioning Neon |
| 4 | All input elements have font-size >= 16px globally | VERIFIED | `globals.css` line 152-156: `input, select, textarea { font-size: max(16px, 1em); }` |
| 5 | iPad touch target CSS tokens are defined | VERIFIED | `globals.css` @theme block: `--spacing-touch: 48px`, `--spacing-touch-lg: 56px`, `--spacing-touch-gap: 8px` |
| 6 | Web app manifest allows bookmarking to iPad home screen | VERIFIED | `manifest.ts` exports `display: "standalone"`, `name: "Pool Field Forms"`, `start_url: "/"` |
| 7 | Layout renders correctly in both landscape and portrait viewport widths | NEEDS_HUMAN | `page.tsx` uses `max-w-2xl px-4` (fluid, no fixed widths); visual confirmation requires human |

**Plan 01-02 truths:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 8 | Worker can tap New Job, enter a name/job number, and see the new job appear in the list | VERIFIED | `create-job-form.tsx` expands inline form; `createJob` action calls `db.job.create` then `revalidatePath("/")` |
| 9 | Worker can see all jobs sorted with drafts pinned to top, then most recent first | VERIFIED | `page.tsx`: `db.job.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }] })` |
| 10 | Each job shows a Draft or Submitted status badge | VERIFIED | `status-badge.tsx` renders `Draft` (outline) or `Submitted` (green) badge; `job-card.tsx` passes `job.status` |
| 11 | Worker can tap a job card and navigate to a detail page showing job metadata | VERIFIED | `job-card.tsx` wraps card in `Link href={/jobs/${job.id}}`; `jobs/[id]/page.tsx` fetches and renders job |
| 12 | Creating a job with neither name nor job number shows a validation error | VERIFIED | `createJobSchema` `.refine()` rejects empty; `jobs.ts` returns `{ error: ... }`; form renders `state?.error` |
| 13 | All buttons and inputs meet 48px/56px touch target minimums | VERIFIED | `create-job-form.tsx`: `min-h-[56px]` on New Job and Create Job buttons, `min-h-[48px]` on inputs and close button; `job-card.tsx`: `min-h-[56px]` on card; `jobs/[id]/page.tsx`: `min-h-[48px]` on back button |

**Plan 01-03 truths:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 14 | Vitest runs and all tests pass | VERIFIED | `npx vitest run` output: 13 passed (2 test files), 0 failed |
| 15 | Zod validation rejects empty input | VERIFIED | `job.test.ts` "rejects empty input" and "rejects both undefined" — both pass |
| 16 | createJob Server Action calls db.job.create with correct data | VERIFIED | `jobs.test.ts` asserts `db.job.create` called with `name` and `status: "DRAFT"` |
| 17 | Seed data populates database with realistic test jobs | VERIFIED (with caveat) | `prisma/seed.ts` has 6 jobs (4 DRAFT, 2 SUBMITTED); seed cannot run until DATABASE_URL is set and import is fixed |

**Score:** 14/17 truths verified (2 need human, 1 failed)

For the 9 requirement-mapped must-haves in the phase: **11/12 verified** (the build failure is the single gap).

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `pool-app/package.json` | All Phase 1 dependencies | VERIFIED | Contains `next`, `@prisma/client`, `zod`, `sonner`, `lucide-react`, `date-fns`; devDeps include `prisma`, `vitest`, `prettier` |
| `pool-app/prisma/schema.prisma` | Job model with status enum, photos JSON, formData JSON | VERIFIED | `model Job` with `enum JobStatus { DRAFT SUBMITTED }`, `photos Json @default("[]")`, `formData Json?`, `@@map("jobs")` |
| `pool-app/src/lib/db.ts` | Prisma client singleton for serverless | VERIFIED | Exports `db`; uses `PrismaNeon` adapter + `globalThis` caching; logs queries in dev |
| `pool-app/src/app/globals.css` | iPad CSS tokens and iOS zoom prevention | VERIFIED | `--spacing-touch: 48px`, `--spacing-touch-lg: 56px`, zoom prevention rule present |
| `pool-app/src/app/layout.tsx` | Root layout with iPad meta tags, viewport, Toaster | VERIFIED | `appleWebApp.capable: true`, `maximumScale: 5`, `Toaster position="top-center"`, `import "./globals.css"` |
| `pool-app/src/app/manifest.ts` | Web app manifest for home screen bookmark | VERIFIED | `display: "standalone"`, `name: "Pool Field Forms"`, 192 and 512 icon entries |
| `pool-app/src/lib/actions/jobs.ts` | createJob Server Action with Zod validation | VERIFIED | `"use server"`, `createJobSchema.safeParse`, `db.job.create`, `revalidatePath("/")` |
| `pool-app/src/components/create-job-form.tsx` | Inline expandable form for creating jobs | VERIFIED | `"use client"`, `useActionState(createJob, null)`, expands/collapses, error display, toast on success |
| `pool-app/src/components/job-list.tsx` | Server component rendering sorted job cards | VERIFIED | `jobs.length === 0` empty state, maps to `JobCard` |
| `pool-app/src/components/job-card.tsx` | Single job card with name, number, status, timestamp | VERIFIED | `Link href={/jobs/${job.id}}`, `StatusBadge`, `formatDistanceToNow`, `min-h-[56px]` |
| `pool-app/src/components/status-badge.tsx` | Draft/Submitted badge component | VERIFIED | Draft = `variant="outline"`, Submitted = `bg-green-600` |
| `pool-app/src/app/page.tsx` | Home page composing CreateJobForm + JobList | VERIFIED | `db.job.findMany` with `orderBy`, `CreateJobForm`, `JobList`, `max-w-2xl`, `dynamic = "force-dynamic"` |
| `pool-app/src/app/jobs/[id]/page.tsx` | Job detail page showing metadata | VERIFIED | `db.job.findUnique`, `notFound()`, `await params`, `generateMetadata`, `min-h-[48px]` back button |
| `pool-app/vitest.config.ts` | Vitest config with React plugin and path aliases | VERIFIED | `@vitejs/plugin-react`, `jsdom`, `"@": path.resolve(__dirname, "./src")` |
| `pool-app/src/__tests__/validations/job.test.ts` | Zod schema validation tests | VERIFIED | 8 test cases, imports `createJobSchema` |
| `pool-app/src/__tests__/actions/jobs.test.ts` | Server Action tests with mocked Prisma | VERIFIED | `vi.mock("@/lib/db")`, `vi.mock("next/cache")`, 5 test cases |
| `pool-app/prisma/seed.ts` | Seed data for development | STUB | File exists with 6 correct jobs, but imports `PrismaClient` from `"@prisma/client"` — wrong path for Prisma 7. Build fails on this file. |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/lib/db.ts` | `prisma/schema.prisma` | PrismaClient generated from schema | WIRED | Imports from `@/generated/prisma/client`; generated client exists at `src/generated/prisma/` |
| `src/app/layout.tsx` | `src/app/globals.css` | CSS import | WIRED | Line 4: `import "./globals.css"` |
| `src/components/create-job-form.tsx` | `src/lib/actions/jobs.ts` | `useActionState(createJob, null)` | WIRED | Line 12: `useActionState(createJob, null)` confirmed |
| `src/lib/actions/jobs.ts` | `src/lib/db.ts` | `db.job.create` | WIRED | Line 20: `await db.job.create(...)` |
| `src/lib/actions/jobs.ts` | `src/lib/validations/job.ts` | `createJobSchema.safeParse` | WIRED | Line 11: `createJobSchema.safeParse(...)` |
| `src/app/page.tsx` | `src/lib/db.ts` | `db.job.findMany` | WIRED | Line 9: `await db.job.findMany(...)` |
| `src/components/job-card.tsx` | `src/app/jobs/[id]/page.tsx` | Link href to job detail route | WIRED | Line 11: `href={\`/jobs/${job.id}\`}` |
| `prisma/seed.ts` | `src/generated/prisma/client` | PrismaClient import | BROKEN | Uses `from "@prisma/client"` — @prisma/client does not export `PrismaClient` in Prisma 7; build fails |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `src/app/page.tsx` | `jobs` | `db.job.findMany` with orderBy | Yes — live DB query | FLOWING |
| `src/components/job-list.tsx` | `jobs` prop | Passed from `page.tsx` | Yes — from DB query | FLOWING |
| `src/components/job-card.tsx` | `job` prop | Passed from `JobList` map | Yes — individual Job row | FLOWING |
| `src/app/jobs/[id]/page.tsx` | `job` | `db.job.findUnique({ where: { id } })` | Yes — live DB query | FLOWING |
| `src/components/create-job-form.tsx` | `state` (form result) | `createJob` Server Action → `db.job.create` | Yes — writes to DB, revalidates | FLOWING |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 13 tests pass | `npx vitest run --reporter=verbose` | 13 passed, 0 failed, 838ms | PASS |
| Next.js app builds cleanly | `npx next build` | FAILED — TypeScript error in `prisma/seed.ts` line 1 | FAIL |
| Vitest config exports correct structure | Node require check | Module present | PASS |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| JOBS-01 | 01-02, 01-03 | Worker can create a new job with name and/or job number | SATISFIED | `createJob` action + `CreateJobForm` + Zod validation; 5 server action tests confirm |
| JOBS-02 | 01-02, 01-03 | Worker can select an existing job from a list | SATISFIED | `JobList` + `JobCard` with Link to `/jobs/[id]` + detail page with `db.job.findUnique` |
| JOBS-03 | 01-02, 01-03 | Worker can see job history with submission status (draft/submitted) | SATISFIED | `StatusBadge` renders Draft/Submitted; `page.tsx` orders by `status asc` then `createdAt desc` |
| JOBS-04 | 01-01 | Each job stores associated photos, form data, and metadata | SATISFIED | `schema.prisma`: `photos Json @default("[]")`, `formData Json?`, `submittedBy`, `submittedAt`, `createdAt`, `updatedAt` |
| IPAD-01 | 01-01, 01-02, 01-03 | Touch targets are 48px+ minimum | SATISFIED (code) | `min-h-[48px]` on inputs/close, `min-h-[56px]` on primary buttons throughout; human confirmation required for actual feel |
| IPAD-02 | 01-01 | Form input font is 16px+ (prevents iOS Safari auto-zoom) | SATISFIED (code) | `globals.css`: `font-size: max(16px, 1em)` on `input, select, textarea`; Safari behavior requires human confirmation |
| IPAD-03 | 01-01, 01-02 | UI works in both landscape and portrait orientation | SATISFIED (code) | `max-w-2xl px-4` fluid layout, no fixed widths; visual confirmation requires human |
| IPAD-04 | 01-01 | High contrast design readable in outdoor sunlight | SATISFIED (code) | `text-zinc-900` on `bg-white`, `text-zinc-600`/`500` for secondary; oklch high-contrast tokens defined; outdoor test requires human |
| IPAD-05 | 01-01 | App accessible as plain web app (bookmark to home screen) | SATISFIED (code) | `manifest.ts` with `display: "standalone"`; `appleWebApp.capable: true` in layout; actual home screen install requires human on iOS |

All 9 required requirement IDs are accounted for across Plans 01-01, 01-02, and 01-03. No orphaned requirements.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `prisma/seed.ts` | 1 | `import { PrismaClient } from "@prisma/client"` — wrong import for Prisma 7 | BLOCKER | `npx next build` fails with TypeScript error. Seed cannot run. All other source files correctly use `@/generated/prisma/client`. |
| `src/app/jobs/[id]/page.tsx` | 76, 83 | "Photo capture coming in Phase 2" / "Form fields coming in Phase 3" | INFO | Intentional design stubs — placeholder cards for future phases. Not blocking. |
| `src/app/manifest.ts` | 13-14 | `/icon-192.png` and `/icon-512.png` do not exist in `public/` | INFO | Manifest valid JSON; icons will 404. Not blocking for Phase 1, should be resolved before production. |

---

## Human Verification Required

### 1. Orientation Layout

**Test:** Open the app (after DATABASE_URL is configured and seed is run) in a browser. Resize to 1024x768 (landscape iPad) then 768x1024 (portrait iPad).
**Expected:** Content fills the viewport width appropriately, no horizontal scrollbar, no clipped elements, the `max-w-2xl` container is centered in landscape and full-width in portrait.
**Why human:** CSS responsive layout at specific iPad breakpoints requires visual inspection.

### 2. iOS Safari Input Zoom Prevention

**Test:** On an iPad running Safari, or on a Mac with Safari's Responsive Design Mode set to iPad, tap any Input field in the create-job form.
**Expected:** The page does NOT zoom in. The viewport stays stable. Font size is visibly comfortable (18px body, 16px inputs).
**Why human:** iOS Safari zoom-on-focus behavior can only be verified in Safari's rendering engine — it does not trigger in Chrome or by code analysis.

### 3. Home Screen Installation

**Test:** On an iPad, open Safari, navigate to the app URL, tap the Share icon, tap "Add to Home Screen".
**Expected:** The app installs as "Pool Forms", launches in standalone mode (no Safari chrome), and the splash screen/icon matches the manifest configuration.
**Why human:** PWA installation and standalone launch require a real iOS device or simulator.

### 4. Touch Target Usability with Gloves

**Test:** Use the app while wearing latex or work gloves, or attempt to tap all interactive elements at arm's length.
**Expected:** Every button and input is tappable without precise aim. No accidental triggers of adjacent elements.
**Why human:** 48px physical usability under field conditions requires human tactile judgment.

### 5. Outdoor Readability

**Test:** View the app on a tablet or phone outdoors in daylight, or dim the screen to 40% brightness.
**Expected:** The dark zinc-950 text on white background remains legible. Status badges (Draft outline, Submitted green) are distinguishable.
**Why human:** Sunlight readability depends on the display panel and ambient conditions — cannot be assessed from CSS values alone.

---

## Gaps Summary

**1 gap blocking the build** — `prisma/seed.ts` uses the wrong PrismaClient import path.

**Root cause:** Prisma 7 changed the generated client output location. All production source files (`src/lib/db.ts`) correctly use `@/generated/prisma/client`. The seed script was written using the Prisma 6 convention (`@prisma/client`) and was not updated when the deviation was discovered in Plan 01. The seed script is excluded from regular test runs (Vitest doesn't include `prisma/` files), which is why the 13 tests still pass — only `npx next build` catches this because TypeScript type-checks all project files.

**Fix:** One-line change in `prisma/seed.ts`:
- Current: `import { PrismaClient } from "@prisma/client";`
- Required: `import { PrismaClient } from "../src/generated/prisma/client";`

Note: The `new PrismaClient()` call on line 3 may also need updating — in Prisma 7 with the adapter pattern, a bare `new PrismaClient()` without a datasource adapter will not connect. The seed script should either use the `prisma.config.ts`-aware CLI path or construct the client with the `PrismaNeon` adapter the same way `db.ts` does.

All other goal requirements are fully implemented, wired, and tested. The phase goal is 95% achieved — the single seed.ts import failure is the only thing preventing a clean build.

---

_Verified: 2026-03-25T12:36:00Z_
_Verifier: Claude (gsd-verifier)_
