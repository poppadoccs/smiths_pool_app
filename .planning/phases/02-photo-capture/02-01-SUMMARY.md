---
phase: 02-photo-capture
plan: 01
subsystem: api
tags: [vercel-blob, photo-upload, server-actions, prisma, compression]

# Dependency graph
requires:
  - phase: 01-foundation-jobs
    provides: "Job model with photos JSON field, Prisma db client, server action pattern"
provides:
  - "PhotoMetadata type for photo JSON array schema"
  - "isHeicFile helper for HEIC detection"
  - "COMPRESSION_OPTIONS constant for client-side compression config"
  - "savePhotoMetadata server action to persist photo URLs to job"
  - "deletePhoto server action to remove from Blob storage and job"
  - "/api/photos/upload route for Vercel Blob client token exchange"
affects: [02-photo-capture, 05-email-submission]

# Tech tracking
tech-stack:
  added: ["@vercel/blob", "browser-image-compression", "heic2any"]
  patterns: ["Vercel Blob handleUpload token exchange", "JSON array append/filter for photos field"]

key-files:
  created:
    - pool-app/src/lib/photos.ts
    - pool-app/src/lib/actions/photos.ts
    - pool-app/src/app/api/photos/upload/route.ts
    - pool-app/src/__tests__/actions/photos.test.ts
  modified:
    - pool-app/package.json
    - pool-app/package-lock.json

key-decisions:
  - "Corrected onBeforeGenerateToken signature to match @vercel/blob 2.x API (3 params: pathname, clientPayload, multipart)"
  - "onUploadCompleted is a no-op logging step; DB update handled via server action from client"

patterns-established:
  - "Photo metadata server actions: findUnique -> modify JSON array -> update -> revalidatePath"
  - "Vercel Blob token exchange route pattern for client uploads"

requirements-completed: [PHOT-04, PHOT-05, PHOT-06]

# Metrics
duration: 5min
completed: 2026-03-25
---

# Phase 2 Plan 1: Photo Server Infrastructure Summary

**Vercel Blob upload route, savePhotoMetadata/deletePhoto server actions, PhotoMetadata type, HEIC detection helper, and compression config constant with 5 passing TDD tests**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-25T18:08:20Z
- **Completed:** 2026-03-25T18:13:44Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Installed @vercel/blob, browser-image-compression, and heic2any dependencies
- Created shared PhotoMetadata type, isHeicFile helper, and COMPRESSION_OPTIONS constant
- Created /api/photos/upload token exchange route restricting uploads to JPEG/PNG/WebP (5MB max)
- Implemented savePhotoMetadata (appends to JSON array) and deletePhoto (calls Blob del + filters array) server actions
- All 5 TDD tests pass covering save-append, save-empty-array, save-job-not-found, delete-with-blob, delete-job-not-found
- Zero regressions: all 18 tests green

## Task Commits

Each task was committed atomically:

1. **Task 1: Install dependencies, create shared types, and Blob upload API route** - `bdd8053` (feat)
2. **Task 2 RED: Failing tests for photo server actions** - `1f42c46` (test)
3. **Task 2 GREEN: Implement savePhotoMetadata and deletePhoto** - `dc1b1c1` (feat)

## Files Created/Modified
- `pool-app/src/lib/photos.ts` - PhotoMetadata type, isHeicFile helper, COMPRESSION_OPTIONS constant
- `pool-app/src/lib/actions/photos.ts` - Server actions for saving photo metadata and deleting photos from Blob + DB
- `pool-app/src/app/api/photos/upload/route.ts` - Vercel Blob handleUpload token exchange endpoint (JPEG/PNG/WebP, 5MB)
- `pool-app/src/__tests__/actions/photos.test.ts` - 5 unit tests for photo server actions
- `pool-app/package.json` - Added @vercel/blob, browser-image-compression, heic2any dependencies

## Decisions Made
- Corrected onBeforeGenerateToken callback signature to match actual @vercel/blob 2.x API (3 params instead of 1 in the plan)
- onUploadCompleted left as logging no-op since it does not work in local dev; DB persistence handled via separate server action call from client

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed onBeforeGenerateToken signature**
- **Found during:** Task 1 (Blob upload API route)
- **Issue:** Plan specified `onBeforeGenerateToken: async (pathname) =>` but @vercel/blob 2.x expects `(pathname, clientPayload, multipart)`
- **Fix:** Updated callback to accept all 3 parameters with underscore-prefixed unused params
- **Files modified:** pool-app/src/app/api/photos/upload/route.ts
- **Verification:** TypeScript compiles cleanly with `npx tsc --noEmit`
- **Committed in:** bdd8053 (Task 1 commit)

**2. [Rule 3 - Blocking] Fixed Vitest -x flag for v4**
- **Found during:** Task 2 (TDD RED phase)
- **Issue:** Plan used `vitest run ... -x` but Vitest 4.1.1 does not support `-x` flag
- **Fix:** Used `--bail 1` instead for the same behavior
- **Verification:** Tests run successfully with `--bail 1`
- **Committed in:** N/A (runtime command fix, no code change)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required

**External services require manual configuration.** The Vercel Blob store needs provisioning before photo upload will work in deployed environments:
- Create a Blob store via Vercel Dashboard -> Storage -> Create Store -> Blob
- Set `BLOB_READ_WRITE_TOKEN` environment variable (from Vercel dashboard or `vercel env pull`)
- This is NOT blocking for development of client components (Plan 02) which can be built without the token

## Next Phase Readiness
- Server-side photo infrastructure is complete and tested
- Plan 02 (client photo components) can now build PhotoUpload and PhotoGallery components that call these server actions
- Plan 03 (integration) can wire everything together on the job detail page

## Self-Check: PASSED

- All 5 created files verified on disk
- All 3 task commits verified in git log (bdd8053, 1f42c46, dc1b1c1)
- 18/18 tests pass (5 new + 13 existing)
- TypeScript compiles cleanly

---
*Phase: 02-photo-capture*
*Completed: 2026-03-25*
