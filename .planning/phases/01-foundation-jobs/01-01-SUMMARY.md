---
phase: 01-foundation-jobs
plan: 01
subsystem: infra
tags: [nextjs, prisma, tailwind, shadcn, neon, ipad, css-tokens, zod]

# Dependency graph
requires: []
provides:
  - Next.js 16 app shell in pool-app/ with Tailwind 4 and shadcn/ui
  - Prisma 7 schema with Job model (status enum, photos JSON, formData JSON)
  - iPad CSS design tokens (48px/56px touch targets, 16px input font)
  - iOS Safari zoom prevention global rule
  - Web app manifest for iPad home screen bookmarking
  - Root layout with apple-mobile-web-app meta tags and viewport config
  - Zod validation schema for job creation
  - Prisma client singleton with Neon adapter
affects: [01-02, 01-03, 02-photo-capture, 03-form-renderer]

# Tech tracking
tech-stack:
  added: [next@16.2.1, react@19.2.4, tailwindcss@4, prisma@7.5.0, @prisma/client@7.5.0, @prisma/adapter-neon, @neondatabase/serverless, zod@4.3.6, sonner, lucide-react, date-fns, shadcn@4.1.0, vitest@4.1.1, prettier]
  patterns: [prisma-singleton-with-adapter, server-components, css-design-tokens, ios-zoom-prevention]

key-files:
  created:
    - pool-app/prisma/schema.prisma
    - pool-app/src/lib/db.ts
    - pool-app/src/types/index.ts
    - pool-app/src/lib/validations/job.ts
    - pool-app/src/app/manifest.ts
    - pool-app/.prettierrc
  modified:
    - pool-app/package.json
    - pool-app/src/app/globals.css
    - pool-app/src/app/layout.tsx
    - pool-app/src/app/page.tsx

key-decisions:
  - "Prisma 7 requires driver adapter pattern -- used @prisma/adapter-neon instead of direct URL in schema"
  - "Preserved shadcn/ui theme variables in globals.css while adding iPad design tokens in separate @theme block"
  - "Removed nested .git from create-next-app to keep pool-app/ as a subdirectory, not a submodule"

patterns-established:
  - "Prisma client singleton: src/lib/db.ts with globalThis caching and PrismaNeon adapter"
  - "iPad CSS tokens: @theme block in globals.css with --spacing-touch, --spacing-touch-lg, --font-size-* variables"
  - "iOS zoom prevention: global rule on input/select/textarea with font-size: max(16px, 1em)"
  - "Zod validation schemas: src/lib/validations/ directory with shared schemas"

requirements-completed: [JOBS-04, IPAD-01, IPAD-02, IPAD-03, IPAD-04, IPAD-05]

# Metrics
duration: 11min
completed: 2026-03-25
---

# Phase 1 Plan 1: Scaffold + Database + iPad CSS Summary

**Next.js 16 app with Prisma 7 Job schema, Neon adapter, iPad-first CSS tokens (48px touch targets, 16px zoom prevention), and web manifest for home screen bookmarking**

## Performance

- **Duration:** 11 min
- **Started:** 2026-03-25T16:03:52Z
- **Completed:** 2026-03-25T16:15:31Z
- **Tasks:** 2/2
- **Files modified:** 10

## Accomplishments

- Next.js 16.2.1 app scaffolded in pool-app/ with Tailwind 4, shadcn/ui (button, card, input, badge, separator), and all Phase 1 dependencies
- Prisma 7 Job model with status enum (DRAFT/SUBMITTED), photos JSON, formData JSON, timestamptz fields, and composite index
- iPad CSS design tokens established: 48px minimum touch targets, 56px primary actions, 16px input fonts, 18px body text, high-contrast oklch colors
- Root layout with apple-mobile-web-app meta tags, viewport config (maximumScale: 5 for accessibility), and sonner Toaster
- Web app manifest enabling iPad home screen bookmarking

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold Next.js 16 app with all Phase 1 dependencies** - `0ad7f25` (feat)
2. **Task 2: Configure Prisma schema, iPad CSS tokens, root layout, and manifest** - `3b33fbe` (feat)

## Files Created/Modified

- `pool-app/package.json` - All Phase 1 dependencies (next, prisma, zod, sonner, lucide-react, date-fns, vitest, prettier)
- `pool-app/prisma/schema.prisma` - Job model with status enum, photos JSON, formData JSON, composite index
- `pool-app/prisma.config.ts` - Prisma 7 config with datasource URL from DATABASE_URL env var
- `pool-app/src/lib/db.ts` - Prisma client singleton with PrismaNeon adapter and globalThis caching
- `pool-app/src/types/index.ts` - TypeScript types for JobStatus and CreateJobInput
- `pool-app/src/lib/validations/job.ts` - Zod schema for job creation (name and/or job number required)
- `pool-app/src/app/globals.css` - shadcn/ui theme variables + iPad CSS design tokens + iOS zoom prevention rule
- `pool-app/src/app/layout.tsx` - iPad-optimized root layout with apple-mobile-web-app meta, viewport, Toaster
- `pool-app/src/app/manifest.ts` - Web app manifest for standalone display and home screen bookmarking
- `pool-app/src/app/page.tsx` - Minimal placeholder page (replaced in Plan 02)
- `pool-app/src/components/ui/*.tsx` - shadcn/ui components (button, card, input, badge, separator)
- `pool-app/.prettierrc` - Prettier config with tailwindcss plugin

## Decisions Made

- **Prisma 7 adapter pattern:** Prisma 7 no longer supports `url = env("DATABASE_URL")` in schema.prisma. Instead, it uses `prisma.config.ts` for the datasource URL and requires a driver adapter (`@prisma/adapter-neon`) in the PrismaClient constructor. This is a breaking change from Prisma 6 and the plan's research was based on Prisma 6 conventions. Adapted the db.ts singleton to use the new pattern.
- **Preserved shadcn/ui globals.css:** The shadcn/ui init creates an extensive globals.css with theme variables. Rather than replacing it entirely (as the plan suggested), preserved all shadcn variables and added iPad tokens in a separate `@theme` block. This ensures shadcn components render correctly.
- **Removed nested .git:** create-next-app initializes its own git repo in pool-app/. Removed the nested .git to keep pool-app/ as a plain subdirectory within the existing repo.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Prisma 7 requires driver adapter, not direct URL in schema**
- **Found during:** Task 2 (Prisma schema and db.ts creation)
- **Issue:** Plan specified `import { PrismaClient } from "@prisma/client"` and `new PrismaClient({ log: ... })`. Prisma 7 generates client to `src/generated/prisma/`, requires import from `@/generated/prisma/client`, and mandates either an `adapter` or `accelerateUrl` in the constructor.
- **Fix:** Installed `@prisma/adapter-neon` and `@neondatabase/serverless`. Updated db.ts to import from generated path, create a `PrismaNeon` adapter with the connection string, and pass it to PrismaClient.
- **Files modified:** pool-app/src/lib/db.ts, pool-app/package.json
- **Verification:** `npx prisma validate` passes, `npx next build` completes without errors
- **Committed in:** 3b33fbe (Task 2 commit)

**2. [Rule 3 - Blocking] Preserved shadcn/ui globals.css instead of replacing**
- **Found during:** Task 2 (globals.css replacement)
- **Issue:** Plan said to replace globals.css with iPad tokens only. But shadcn/ui init created extensive theme variables that shadcn components depend on. Replacing entirely would break all shadcn components.
- **Fix:** Kept all shadcn/ui theme variables and `:root`/`.dark` blocks intact. Added iPad design tokens in a separate `@theme` block and the iOS zoom prevention rule at the end.
- **Files modified:** pool-app/src/app/globals.css
- **Verification:** `npx next build` succeeds, shadcn components remain functional
- **Committed in:** 3b33fbe (Task 2 commit)

**3. [Rule 3 - Blocking] Removed nested .git directory from create-next-app**
- **Found during:** Task 1 (git commit)
- **Issue:** `create-next-app` initializes a git repo inside pool-app/, creating a nested repository that git treats as a submodule.
- **Fix:** Removed pool-app/.git directory before staging files.
- **Files modified:** None (removed generated .git directory)
- **Verification:** `git add pool-app/` works without submodule warning
- **Committed in:** 0ad7f25 (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (3 blocking)
**Impact on plan:** All auto-fixes were necessary for the build to succeed. The Prisma 7 adapter change is the most significant -- it affects how every future plan creates PrismaClient instances. No scope creep.

## Known Stubs

- `pool-app/src/app/page.tsx` line 4: "Job list coming in Plan 02" -- intentional placeholder, replaced in 01-02-PLAN.md
- `pool-app/src/app/manifest.ts` icons reference `/icon-192.png` and `/icon-512.png` which don't exist in public/ yet -- placeholder paths for future icon assets

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

Before Plan 02 can connect to the database:
1. Create a Neon Postgres database (free tier at neon.tech)
2. Copy the pooled connection string
3. Set `DATABASE_URL` in `pool-app/.env` to the Neon connection string
4. Run `cd pool-app && npx prisma db push` to create the schema in the database

## Next Phase Readiness

- App shell is complete and builds successfully
- Prisma schema is validated and client is generated
- iPad CSS tokens are available as Tailwind utilities (`min-h-touch`, `min-h-touch-lg`, `gap-touch-gap`, `text-input`, `text-body`, `text-heading`)
- Ready for Plan 02: job list page, create job form, job detail page, server actions
- **Blocker for Plan 02:** DATABASE_URL must be set before any database operations

## Self-Check: PASSED

All 11 files verified present. Both commit hashes (0ad7f25, 3b33fbe) found in git log.

---
*Phase: 01-foundation-jobs*
*Completed: 2026-03-25*
