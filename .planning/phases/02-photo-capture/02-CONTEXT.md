# Phase 2: Photo Capture - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Add photo capture, compression, upload, and gallery management to the job detail page. Workers take photos via iPad camera or attach from library, photos are compressed and converted to JPEG client-side, uploaded to Vercel Blob, displayed in a thumbnail gallery per job. Workers can enlarge and delete photos before submission.

</domain>

<decisions>
## Implementation Decisions

### Photo Capture Method
- Native HTML `<input type="file" accept="image/*" capture="environment">` — opens iPad camera directly, most reliable on Safari
- `multiple` attribute to allow selecting several photos at once from library
- Vercel Blob via client-side upload — bypasses 4.5MB server body limit for large iPad photos

### Photo Processing
- browser-image-compression library for client-side compression and HEIC→JPEG conversion
- Max 1MB per photo, 80% quality JPEG — good for field documentation, keeps email under limits
- HEIC converted to JPEG client-side during compression step

### Photo Gallery UX
- Responsive thumbnail grid (3-4 per row on iPad) for quick visual scan
- Tap thumbnail → full-screen overlay with close button for enlarging
- Delete icon on each thumbnail — deliberate action, hard to do accidentally
- Progress bar per photo during upload — worker knows something is happening

### Claude's Discretion
- Vercel Blob configuration and token generation
- Photo metadata storage in database (blob URL, original filename, size)
- Exact component structure for gallery and upload
- Error handling for failed uploads

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- pool-app/src/lib/db.ts — Prisma client singleton with Neon adapter
- pool-app/prisma/schema.prisma — Job model with `photos Json` field ready for photo URLs
- pool-app/src/app/jobs/[id]/page.tsx — Job detail page where photo gallery will live
- pool-app/src/app/globals.css — iPad CSS tokens (48px touch targets, high contrast)

### Established Patterns
- Server Actions for mutations (lib/actions/jobs.ts pattern)
- useActionState for form state management
- shadcn/ui components with Tailwind 4

### Integration Points
- Job detail page (pool-app/src/app/jobs/[id]/page.tsx) — photo gallery added here
- Prisma Job model photos field — stores array of blob URLs
- Vercel Blob — new external service, needs BLOB_READ_WRITE_TOKEN

</code_context>

<specifics>
## Specific Ideas

- Photos must be compressed BEFORE upload, not after — iPad photos are 5-12MB
- HEIC must never reach the server — Windows office PCs can't open them
- Progress feedback is critical — workers on cellular need to see something is happening

</specifics>

<deferred>
## Deferred Ideas

- Photo categorization (Before/During/After) — v2 feature
- Photo reordering — not needed for v1

</deferred>
