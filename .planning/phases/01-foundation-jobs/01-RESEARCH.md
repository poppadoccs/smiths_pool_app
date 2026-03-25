# Phase 1: Foundation + Jobs - Research

**Researched:** 2026-03-25
**Domain:** Next.js 16 App Router scaffolding, Prisma + Neon Postgres, iPad-optimized job management UI
**Confidence:** HIGH

## Summary

Phase 1 establishes the entire application foundation: scaffolding a Next.js 16 project with Tailwind 4 and shadcn/ui, setting up Prisma with Neon Postgres, building an iPad-optimized job list and job detail view, and deploying to Vercel. This is a greenfield phase -- the existing repository contains only the Lucac Vault MCP server (Python), so the Next.js app must be scaffolded in a new subdirectory or the project needs restructuring.

The critical constraint is iPad field usability: 48px+ touch targets, 16px+ input fonts (prevents iOS Safari auto-zoom), high contrast for outdoor sunlight, and responsive orientation support. These CSS/layout decisions cascade through every future phase, so getting the design tokens and component sizing right here prevents rework later.

A key finding from research: Prisma cannot dynamically switch between SQLite and PostgreSQL providers via environment variables. The STACK.md suggested SQLite for dev / Postgres for prod, but this is not supported. The correct approach is to use Neon Postgres for both development and production, with Neon's free tier providing 100 compute-hours/month which is more than sufficient.

**Primary recommendation:** Scaffold a Next.js 16 app in a subdirectory (e.g., `pool-app/`), configure Prisma with Neon Postgres from day one, establish iPad-first CSS design tokens as Tailwind theme extensions, and deploy a working job list + job detail to Vercel before moving to Phase 2.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Next.js 16 App Router + Tailwind 4 + shadcn/ui -- research-validated stack, Vercel deploy
- Neon Postgres via Prisma for database -- free tier, serverless, Vercel Marketplace
- Responsive layout supporting both landscape and portrait iPad orientations
- Single page with job list as home, tap job to open detail view -- minimal nav, one level deep
- Inline "New Job" button at top of list -> expands form fields (name + number) -- fast, no page change
- Job list sorted most recent first, with draft jobs pinned to top
- Two status labels: Draft (not submitted) and Submitted -- matches paper workflow
- "Submitted by" text field on the job -- no login needed, crews share iPads
- 48px minimum touch targets, 56px for primary actions -- dirty/gloved hands
- Dark text on light background, high contrast, zinc/neutral palette -- outdoor sunlight readability
- 16px base minimum on all inputs (prevents iOS zoom), 18px for body text

### Claude's Discretion
- Prisma schema design and migration strategy
- Exact shadcn/ui component choices for job list and detail views
- Vercel project configuration details
- File/folder structure within the Next.js app

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| JOBS-01 | Worker can create a new job with a name and/or job number | Server Actions + Prisma create, inline expand form pattern, Zod validation |
| JOBS-02 | Worker can select an existing job from a list | Server Component job list with Prisma findMany, Card-based clickable items |
| JOBS-03 | Worker can see job history with submission status (draft/submitted) | Prisma enum status field, sorted query with draft pinning, Badge component for status |
| JOBS-04 | Each job stores associated photos, form data, and metadata | Prisma schema with JSON fields for photos/formData, relation-ready for future phases |
| IPAD-01 | Touch targets are 48px+ minimum for field use | Tailwind theme extension for min-h-12/min-h-14, shadcn/ui component size overrides |
| IPAD-02 | Form input font is 16px+ (prevents iOS Safari auto-zoom) | CSS base rule `input, select, textarea { font-size: max(16px, 1em) }`, Tailwind text-base minimum |
| IPAD-03 | UI works in both landscape and portrait orientation | Responsive Tailwind grid, no fixed widths, CSS container queries or breakpoints |
| IPAD-04 | High contrast design readable in outdoor sunlight | zinc-900 on white/zinc-50 text, WCAG AAA contrast ratios, no light grays for text |
| IPAD-05 | App is accessible as a plain web app (bookmark to home screen) | Web app manifest, apple-mobile-web-app-capable meta tag, apple-touch-icon |
</phase_requirements>

## Standard Stack

### Core (Phase 1 Only)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | 16.2.1 | Full-stack React framework | App Router, Server Components, Server Actions. Vercel-native. |
| React | 19.2.4 | UI library | Ships with Next.js 16. useActionState for form pending states. |
| TypeScript | 5.x | Type safety | Ships with Next.js. Catches schema mismatches at build time. |
| Tailwind CSS | 4.2.2 | Styling | CSS-first config. OKLCH color palette for consistent contrast. |
| shadcn/ui | CLI v4 | UI components | Copies into project. Card, Button, Input, Badge, Separator. Not a runtime dependency. |
| Prisma | 7.5.0 | ORM | Type-safe DB access. Schema-as-code. Migrations. |
| @prisma/client | 7.5.0 | Prisma runtime | Generated client for type-safe queries. |
| Zod | 4.3.6 | Validation | Validates job creation input. Shared schema between client and server. |

### Supporting (Phase 1 Only)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| sonner | 2.0.7 | Toast notifications | Success/error feedback on job creation |
| lucide-react | 1.6.0 | Icons | Plus icon for new job, status icons. shadcn/ui default icon set. |
| date-fns | 4.1.0 | Date formatting | Job creation timestamps in list view |

### Development Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Vitest | 4.1.1 | Unit/component testing |
| @testing-library/react | 16.3.2 | Component test utilities |
| Prettier | 3.8.1 | Code formatting |
| prettier-plugin-tailwindcss | 0.7.2 | Tailwind class sorting |
| ESLint | (ships with Next.js) | Linting |

### NOT Needed in Phase 1

| Library | Why Deferred |
|---------|-------------|
| react-hook-form | No complex forms in Phase 1. Job creation is 2 fields. Server Actions handle it. |
| @hookform/resolvers | Depends on react-hook-form. Phase 3. |
| ai / @ai-sdk/openai | AI features are Phase 4. |
| resend / @react-email/components | Email is Phase 5. |
| @vercel/blob | Photo upload is Phase 2. |
| browser-image-compression | Photo compression is Phase 2. |
| Serwist | PWA is out of scope. Plain web app per STATE.md decision. |
| uuid | Prisma generates cuid() IDs natively. No need for uuid package. |

**Installation (Phase 1):**
```bash
# Scaffold Next.js app
npx create-next-app@latest pool-app --typescript --tailwind --eslint --app --src-dir --turbopack

# Initialize shadcn/ui
cd pool-app
npx shadcn@latest init

# Add shadcn components needed for Phase 1
npx shadcn@latest add button card input badge separator

# Database
npm install @prisma/client zod
npm install -D prisma

# Supporting
npm install sonner lucide-react date-fns

# Dev tools
npm install -D prettier prettier-plugin-tailwindcss vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom
```

## Architecture Patterns

### Recommended Project Structure (Phase 1)

```
pool-app/                          # Next.js app root (separate from MCP server)
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout: viewport meta, fonts, iPad meta tags
│   │   ├── page.tsx               # Home = Job list + inline create form
│   │   ├── jobs/
│   │   │   └── [id]/
│   │   │       └── page.tsx       # Job detail view (stub for Phase 2+)
│   │   ├── globals.css            # Tailwind imports + iPad base styles
│   │   └── manifest.ts            # Web app manifest for home screen bookmark
│   ├── components/
│   │   ├── ui/                    # shadcn/ui components (auto-generated)
│   │   ├── job-list.tsx           # Server Component: fetches and renders job cards
│   │   ├── job-card.tsx           # Single job row/card in the list
│   │   ├── create-job-form.tsx    # Client Component: inline expand form
│   │   └── status-badge.tsx       # Draft/Submitted badge
│   ├── lib/
│   │   ├── db.ts                  # Prisma client singleton
│   │   ├── actions/
│   │   │   └── jobs.ts            # Server Actions: createJob
│   │   └── validations/
│   │       └── job.ts             # Zod schemas for job input
│   └── types/
│       └── index.ts               # Shared TypeScript types
├── prisma/
│   ├── schema.prisma              # Database schema
│   └── seed.ts                    # Optional seed data for development
├── .env.local                     # DATABASE_URL (Neon connection string)
├── next.config.ts
├── tailwind.config.ts             # Tailwind theme extensions (if needed beyond CSS)
├── vitest.config.ts
└── package.json
```

### Structure Rationale

- **`pool-app/` subdirectory:** The existing repo contains a Python MCP server. The Next.js app lives in its own directory to avoid conflicts. Vercel deployment can point to this subdirectory via the "Root Directory" setting.
- **`src/app/page.tsx` as home:** The job list IS the home page. No separate route needed. The CONTEXT.md specifies "single page with job list as home."
- **`src/app/jobs/[id]/page.tsx` as stub:** Phase 1 creates the route but it will be minimal -- just showing job metadata. Phase 2+ adds photos, forms, submission.
- **`src/lib/actions/`:** Server Actions in a dedicated directory. Clean separation from UI components.
- **`src/lib/db.ts`:** Prisma client singleton to prevent connection exhaustion in serverless.

### Pattern 1: Prisma Client Singleton for Serverless

**What:** In development, Next.js hot-reloads modules, which creates new Prisma Client instances on every reload, exhausting database connections. The singleton pattern prevents this.

**Example:**
```typescript
// src/lib/db.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```
Source: [Prisma + Next.js Best Practices](https://www.prisma.io/docs/guides/frameworks/nextjs) (HIGH confidence)

### Pattern 2: Server Action with Zod Validation

**What:** Job creation uses a Server Action invoked from a form. Zod validates input server-side. `useActionState` manages pending/error state on the client.

**Example:**
```typescript
// src/lib/validations/job.ts
import { z } from "zod";

export const createJobSchema = z.object({
  name: z.string().min(1, "Job name is required").max(200).optional(),
  jobNumber: z.string().max(50).optional(),
}).refine(data => data.name || data.jobNumber, {
  message: "Either job name or job number is required",
});

// src/lib/actions/jobs.ts
"use server";

import { db } from "@/lib/db";
import { createJobSchema } from "@/lib/validations/job";
import { revalidatePath } from "next/cache";

export async function createJob(prevState: unknown, formData: FormData) {
  const parsed = createJobSchema.safeParse({
    name: formData.get("name"),
    jobNumber: formData.get("jobNumber"),
  });

  if (!parsed.success) {
    return { error: parsed.error.flatten().formErrors.join(", ") };
  }

  await db.job.create({
    data: {
      name: parsed.data.name ?? null,
      jobNumber: parsed.data.jobNumber ?? null,
      status: "DRAFT",
    },
  });

  revalidatePath("/");
  return { success: true };
}
```
Source: [Next.js Forms Guide](https://nextjs.org/docs/app/guides/forms), [Prisma Schema Reference](https://www.prisma.io/docs/orm/reference/prisma-schema-reference) (HIGH confidence)

### Pattern 3: Server Component for Data Fetching

**What:** The job list is a Server Component that fetches directly from Prisma. No API route needed. Data is passed to client components as props where interactivity is required.

**Example:**
```typescript
// src/app/page.tsx (Server Component - default)
import { db } from "@/lib/db";
import { JobList } from "@/components/job-list";
import { CreateJobForm } from "@/components/create-job-form";

export default async function HomePage() {
  const jobs = await db.job.findMany({
    orderBy: [
      { status: "asc" },      // DRAFT first (alphabetically before SUBMITTED)
      { createdAt: "desc" },   // Then most recent first
    ],
  });

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold text-zinc-900">Jobs</h1>
      <CreateJobForm />
      <JobList jobs={jobs} />
    </main>
  );
}
```

### Pattern 4: iPad-First CSS Design Tokens

**What:** Establish iPad-specific design tokens as CSS custom properties and Tailwind theme extensions. These cascade through all future phases.

**Example:**
```css
/* src/app/globals.css */
@import "tailwindcss";

@theme {
  /* iPad field-use touch targets */
  --spacing-touch: 48px;       /* minimum touch target */
  --spacing-touch-lg: 56px;    /* primary action touch target */
  --spacing-touch-gap: 8px;    /* minimum gap between targets */

  /* Typography - prevents iOS Safari zoom */
  --font-size-input: 16px;     /* minimum for inputs */
  --font-size-body: 18px;      /* body text */
  --font-size-heading: 24px;   /* page headings */

  /* High contrast colors for sunlight */
  --color-text-primary: oklch(0.141 0.005 285.82);    /* zinc-950 */
  --color-text-secondary: oklch(0.274 0.006 286.03);  /* zinc-800 */
  --color-bg-primary: oklch(1 0 0);                    /* white */
  --color-bg-secondary: oklch(0.985 0.002 247.84);    /* zinc-50 */
  --color-border: oklch(0.871 0.006 286.29);           /* zinc-300 */
}

/* Prevent iOS Safari zoom on input focus */
input, select, textarea {
  font-size: max(16px, 1em);
}
```

### Anti-Patterns to Avoid

- **Fetching data in Client Components:** Use Server Components for data fetching. Only use `"use client"` for interactive elements (form, buttons with state).
- **API routes for CRUD:** Server Actions replace API routes for mutations in App Router. Do not create `/api/jobs/route.ts` for job creation -- use Server Actions directly.
- **Dynamic Prisma provider switching:** Do NOT try to use SQLite for dev and Postgres for prod. Prisma does not support dynamic provider switching. Use Neon Postgres for both.
- **Global state stores:** No Redux, Zustand, or Context for job data. Server Components + revalidatePath is sufficient for this app.
- **`beforeunload` for save warnings:** Does not work on iOS Safari. Auto-save to server on change instead (relevant for Phase 3 forms, but establish the pattern now).

## Prisma Schema Design (Claude's Discretion)

### Recommended Schema

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum JobStatus {
  DRAFT
  SUBMITTED
}

model Job {
  id          String    @id @default(cuid())
  name        String?               // Job name (optional if jobNumber provided)
  jobNumber   String?   @map("job_number")  // Job number (optional if name provided)
  status      JobStatus @default(DRAFT)
  submittedBy String?   @map("submitted_by") // Free text - who submitted
  submittedAt DateTime? @map("submitted_at") @db.Timestamptz(6)

  // Future phase fields - JSON columns for flexibility
  photos      Json      @default("[]")   // Array of photo URLs/metadata
  formData    Json?     @map("form_data") // Form response data

  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("jobs")
  @@index([status, createdAt(sort: Desc)])
}
```

### Schema Rationale

- **`cuid()` for IDs:** Native to Prisma, no external uuid package needed. URL-safe, sortable-ish.
- **`@db.Timestamptz(6)`:** PostgreSQL TIMESTAMPTZ instead of Prisma's default TIMESTAMP(3). Prevents silent timezone bugs. Verified from [Prisma PostgreSQL datetime best practices](https://medium.com/@basem.deiaa/how-to-fix-prisma-datetime-and-timezone-issues-with-postgresql-1c778aa2d122).
- **`name` and `jobNumber` both optional:** User's friend's company may use either or both. Zod validation enforces at least one is present (application-level, not DB-level).
- **`photos` as JSON default `"[]"`:** Phase 1 creates the field but doesn't populate it. Phase 2 adds photo URLs here. JSON avoids needing a separate Photo model in Phase 1.
- **`formData` as nullable JSON:** Phase 3 populates this. Null means no form filled yet.
- **`@@map("jobs")`:** Snake_case table names follow PostgreSQL convention. Column maps for consistency.
- **`@@index([status, createdAt])`:** Supports the "draft first, then newest" sort query efficiently.

### Migration Strategy

1. Initialize Prisma: `npx prisma init --datasource-provider postgresql`
2. Write schema above
3. Push to Neon: `npx prisma db push` (for development iteration)
4. Generate client: `npx prisma generate`
5. Before production: switch to `npx prisma migrate dev` for tracked migrations

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Touch target enforcement | Custom CSS for every button | Tailwind theme tokens + shadcn size variants | Consistency across all phases, single source of truth |
| iOS Safari zoom prevention | Per-input font-size rules | Global CSS rule `input, select, textarea { font-size: max(16px, 1em) }` | One rule covers all current and future inputs |
| Form validation | Manual if/else checks | Zod schema + Server Action | Type-safe, reusable, same schema client and server |
| Database connection pooling | Manual connection management | Prisma singleton + Neon pooler | Neon's pooler handles serverless connection limits |
| ID generation | uuid package | Prisma `@default(cuid())` | Built-in, no extra dependency |
| Date formatting | Manual date string manipulation | date-fns `formatDistanceToNow` / `format` | Handles locale, relative time, edge cases |
| Toast notifications | Custom notification system | sonner | Touch-friendly, accessible, 2KB |

## Common Pitfalls

### Pitfall 1: Prisma Client Instantiation in Serverless

**What goes wrong:** Every serverless function invocation creates a new Prisma Client, opening a new database connection. In development with hot reload, this quickly exhausts Neon's connection limit (even with pooling).
**Why it happens:** Default Prisma usage creates a client at module scope. Module-level code re-executes on hot reload.
**How to avoid:** Use the singleton pattern (Pattern 1 above). Store the client on `globalThis` in development.
**Warning signs:** "Too many connections" errors in development logs.

### Pitfall 2: iOS Safari Auto-Zoom on Input Focus

**What goes wrong:** When a user taps an input field with font-size < 16px, iOS Safari zooms the viewport to make the text readable. The page doesn't zoom back when the user taps away. The worker sees a zoomed-in page and can't figure out how to get back.
**Why it happens:** Apple designed this "feature" for accessibility. It cannot be disabled via viewport meta tags (Safari ignores `maximum-scale=1` since iOS 10).
**How to avoid:** Set font-size to at least 16px on ALL form inputs. The global CSS rule `input, select, textarea { font-size: max(16px, 1em) }` handles this universally.
**Warning signs:** Testing only on desktop. Any input with Tailwind class `text-sm` (14px) or `text-xs` (12px).

### Pitfall 3: Neon Cold Start on Free Tier

**What goes wrong:** Neon's free tier scales to zero after 5 minutes of inactivity. The first request after idle takes 500-2000ms for the database to wake up. A worker taps "New Job" and sees a long delay.
**Why it happens:** Neon's serverless architecture suspends compute when idle to save resources on the free tier.
**How to avoid:** Accept the cold start for a favor project. Optionally add a loading skeleton / optimistic UI so the delay feels intentional. For production, Neon's paid tier ($19/month) keeps compute warm.
**Warning signs:** First request after lunch break is slow, subsequent requests are fast.

### Pitfall 4: create-next-app in Existing Repository

**What goes wrong:** Running `create-next-app` in the existing repo root would conflict with the Python MCP server files (pyproject.toml, server.py, .venv).
**Why it happens:** create-next-app expects an empty directory or creates a new one.
**How to avoid:** Scaffold into a subdirectory: `npx create-next-app@latest pool-app`. Configure Vercel's "Root Directory" to `pool-app/`.
**Warning signs:** Both Python and Node artifacts in the same directory. Conflicting `.gitignore` patterns.

### Pitfall 5: Prisma SQLite/Postgres Provider Mismatch

**What goes wrong:** Developer tries to use SQLite locally and Postgres in production per STACK.md suggestion. Prisma throws errors because the provider is hardcoded in schema.prisma and cannot be changed via environment variables.
**Why it happens:** Prisma requires the `provider` field to be a literal string, not an env var. This is a known limitation (GitHub issue #1487, open since 2020).
**How to avoid:** Use Neon Postgres for both development and production. Neon's free tier is generous enough (100 CU-hours/month) for development. Set `DATABASE_URL` in `.env.local` to the Neon pooled connection string.
**Warning signs:** Schema has `provider = "sqlite"` or attempts to use conditional logic.

## Code Examples

### Viewport and Meta Tags for iPad

```typescript
// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pool Field Forms",
  description: "Digital job forms for pool installation crews",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Pool Forms",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,         // Allow pinch-zoom for accessibility
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
      </head>
      <body className="bg-white text-zinc-950 antialiased">
        {children}
        <Toaster
          position="top-center"
          toastOptions={{
            style: { fontSize: "16px", padding: "16px" },
          }}
        />
      </body>
    </html>
  );
}
```
Source: [Next.js Metadata API](https://nextjs.org/docs/app/api-reference/functions/generate-metadata), [Apple Safari Meta Tags](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html) (HIGH confidence)

### Web App Manifest

```typescript
// src/app/manifest.ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pool Field Forms",
    short_name: "Pool Forms",
    description: "Digital job forms for pool installation crews",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
```
Source: [Next.js manifest.ts](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest) (HIGH confidence)

### Inline Create Job Form (Client Component)

```typescript
// src/components/create-job-form.tsx
"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X } from "lucide-react";
import { createJob } from "@/lib/actions/jobs";

export function CreateJobForm() {
  const [isOpen, setIsOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createJob, null);

  if (!isOpen) {
    return (
      <Button
        onClick={() => setIsOpen(true)}
        className="mt-4 w-full min-h-[56px] text-lg"
      >
        <Plus className="mr-2 h-5 w-5" />
        New Job
      </Button>
    );
  }

  return (
    <form action={formAction} className="mt-4 space-y-3 rounded-lg border border-zinc-300 bg-zinc-50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900">New Job</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-h-[48px] min-w-[48px]"
          onClick={() => setIsOpen(false)}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <Input
        name="name"
        placeholder="Job name (e.g., Smith Residence)"
        className="min-h-[48px] text-base"
      />
      <Input
        name="jobNumber"
        placeholder="Job number (e.g., 2024-042)"
        className="min-h-[48px] text-base"
      />

      {state?.error && (
        <p className="text-base font-medium text-red-600">{state.error}</p>
      )}

      <Button
        type="submit"
        disabled={pending}
        className="w-full min-h-[56px] text-lg font-semibold"
      >
        {pending ? "Creating..." : "Create Job"}
      </Button>
    </form>
  );
}
```

### Job Card Component

```typescript
// src/components/job-card.tsx
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import type { Job } from "@prisma/client";

export function JobCard({ job }: { job: Job }) {
  return (
    <Link href={`/jobs/${job.id}`}>
      <Card className="min-h-[56px] transition-colors active:bg-zinc-100">
        <CardContent className="flex items-center justify-between p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-medium text-zinc-900">
              {job.name || `Job #${job.jobNumber}`}
            </p>
            {job.name && job.jobNumber && (
              <p className="text-base text-zinc-600">#{job.jobNumber}</p>
            )}
            <p className="text-sm text-zinc-500">
              {formatDistanceToNow(job.createdAt, { addSuffix: true })}
            </p>
          </div>
          <Badge
            variant={job.status === "DRAFT" ? "outline" : "default"}
            className="ml-3 min-h-[32px] text-sm"
          >
            {job.status === "DRAFT" ? "Draft" : "Submitted"}
          </Badge>
        </CardContent>
      </Card>
    </Link>
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| API routes for CRUD | Server Actions with `useActionState` | Next.js 14+ / React 19 | No need for `/api/jobs/route.ts`. Actions called directly from forms. |
| `useFormState` (React DOM) | `useActionState` (React) | React 19 | Renamed and moved to `react` package. Returns `[state, action, pending]`. |
| `tailwind.config.js` | CSS-first `@theme` directive | Tailwind 4 | Config in `globals.css` using `@theme {}` block. No JS config file needed. |
| Prisma `TIMESTAMP(3)` default | `@db.Timestamptz(6)` for PostgreSQL | Best practice, not version-specific | Prevents silent timezone bugs. Prisma default maps to TIMESTAMP without timezone. |
| `generateObject()` in AI SDK | `generateText()` with `output` setting | AI SDK 6.0 | Not relevant for Phase 1 but important context for Phase 4. |

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Next.js runtime | Yes | 25.8.1 | -- |
| npm | Package management | Yes | 11.11.0 | -- |
| npx | Scaffolding tools | Yes | 11.11.0 | -- |
| git | Version control | Yes | 2.53.0 | -- |
| PostgreSQL (Neon) | Database | Remote (Neon SaaS) | Managed | -- |
| Vercel | Deployment | Remote (SaaS) | Managed | -- |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None.

All required tools are available locally. Database and deployment are cloud services accessed via APIs.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.1 + @testing-library/react 16.3.2 |
| Config file | `pool-app/vitest.config.ts` (Wave 0 - must create) |
| Quick run command | `cd pool-app && npx vitest run --reporter=verbose` |
| Full suite command | `cd pool-app && npx vitest run` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| JOBS-01 | Creating a job with name and/or number | unit | `npx vitest run src/__tests__/actions/jobs.test.ts -t "createJob"` | Wave 0 |
| JOBS-02 | Selecting a job from list (navigation) | e2e (manual) | Manual: tap job card, verify navigation to /jobs/[id] | Manual |
| JOBS-03 | Job list shows status, sorted correctly | unit | `npx vitest run src/__tests__/components/job-list.test.tsx -t "sort"` | Wave 0 |
| JOBS-04 | Job schema stores photos, formData, metadata | unit | `npx vitest run src/__tests__/schema/job.test.ts -t "schema"` | Wave 0 |
| IPAD-01 | Touch targets >= 48px | manual | Manual: inspect computed styles on iPad | Manual |
| IPAD-02 | Input font >= 16px (no iOS zoom) | manual | Manual: tap input on iPad, verify no zoom | Manual |
| IPAD-03 | Landscape + portrait work | manual | Manual: rotate iPad, verify layout | Manual |
| IPAD-04 | High contrast in sunlight | manual | Manual: use outdoors | Manual |
| IPAD-05 | Bookmark to home screen works | manual | Manual: add to home screen on iPad, verify launch | Manual |

### Sampling Rate

- **Per task commit:** `cd pool-app && npx vitest run --reporter=verbose`
- **Per wave merge:** `cd pool-app && npx vitest run`
- **Phase gate:** Full suite green + manual iPad verification before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `pool-app/vitest.config.ts` -- Vitest configuration with React plugin
- [ ] `pool-app/src/__tests__/actions/jobs.test.ts` -- Server Action unit tests (mock Prisma)
- [ ] `pool-app/src/__tests__/components/job-list.test.tsx` -- Job list rendering and sorting
- [ ] `pool-app/src/__tests__/schema/job.test.ts` -- Zod schema validation tests
- [ ] Vitest + Testing Library install: `npm install -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom`

## Open Questions

1. **Project subdirectory naming**
   - What we know: The Next.js app must live in a subdirectory to avoid conflicting with the Python MCP server.
   - What's unclear: Should it be `pool-app/`, `app/`, `web/`, or something else?
   - Recommendation: Use `pool-app/` -- descriptive and matches the project purpose. Configure Vercel root directory accordingly.

2. **Neon database provisioning**
   - What we know: Neon Postgres is the locked decision. Vercel Marketplace integration auto-provisions and sets env vars.
   - What's unclear: Whether to use Vercel Marketplace integration (auto-billing via Vercel) or direct Neon signup (separate billing).
   - Recommendation: Use Vercel Marketplace integration for simplest setup. It auto-sets `DATABASE_URL` in Vercel environment.

3. **Seed data for development**
   - What we know: An empty job list is a poor development experience.
   - What's unclear: How many seed jobs to create, what realistic names/numbers look like.
   - Recommendation: Create 5-8 seed jobs with realistic pool company data (e.g., "Smith Residence", "Job #2024-042") with a mix of DRAFT and SUBMITTED statuses.

## Project Constraints (from CLAUDE.md)

- GSD Workflow Enforcement: All file changes must go through GSD commands (`/gsd:execute-phase`, `/gsd:quick`, `/gsd:debug`). Do not make direct repo edits outside a GSD workflow unless explicitly asked.
- No conventions established yet -- Phase 1 will establish patterns that future phases follow.
- Plain responsive web app, NOT PWA (per STATE.md: "iOS PWA has storage limits and camera quirks").

## Sources

### Primary (HIGH confidence)
- [Next.js 16 Installation](https://nextjs.org/docs/app/getting-started/installation) -- scaffolding and setup
- [Next.js Forms Guide](https://nextjs.org/docs/app/guides/forms) -- Server Actions + useActionState pattern
- [Next.js Testing Guide](https://nextjs.org/docs/app/guides/testing) -- Vitest recommended for unit tests
- [Prisma + Next.js Guide](https://www.prisma.io/docs/guides/frameworks/nextjs) -- singleton pattern, best practices
- [Prisma Schema Reference](https://www.prisma.io/docs/orm/reference/prisma-schema-reference) -- models, enums, attributes
- [Neon + Vercel Marketplace](https://vercel.com/marketplace/neon) -- integration setup and env vars
- [Neon + Prisma Guide](https://neon.com/docs/guides/prisma) -- pooled connection string configuration
- [Apple Safari Meta Tags](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html) -- apple-mobile-web-app meta tags
- [CSS-Tricks: 16px prevents iOS form zoom](https://css-tricks.com/16px-or-larger-text-prevents-ios-form-zoom/) -- iOS Safari zoom behavior
- [Tailwind CSS 4 Colors](https://tailwindcss.com/docs/colors) -- OKLCH palette, zinc scale
- [shadcn/ui Components](https://ui.shadcn.com/docs/components) -- Card, Button, Input, Badge

### Secondary (MEDIUM confidence)
- [Prisma DateTime + PostgreSQL timezone issues](https://medium.com/@basem.deiaa/how-to-fix-prisma-datetime-and-timezone-issues-with-postgresql-1c778aa2d122) -- Timestamptz recommendation
- [Prisma provider switching limitation](https://github.com/prisma/prisma/discussions/3642) -- cannot use env var for provider
- [Neon free tier pricing 2026](https://neon.com/pricing) -- 100 CU-hours/month, 0.5GB storage

### Tertiary (LOW confidence)
- None -- all findings verified against primary documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all versions verified against npm registry on 2026-03-25
- Architecture: HIGH -- patterns from official Next.js and Prisma documentation
- Pitfalls: HIGH -- iOS Safari behaviors confirmed via Apple Developer Forums and MDN
- Prisma schema: MEDIUM -- Timestamptz recommendation from community blog, not official Prisma docs (but PostgreSQL best practice is well-established)

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable stack, no fast-moving dependencies)
