# Quick Task 260416-4tw: Real-Environment Proof

**Date:** 2026-04-16
**Commit:** 0668e2a

## What Was Done

### Env Vars — PASS
All three required vars present in `.env.local`:
- `DATABASE_URL` ✓ (Neon PostgreSQL)
- `GOOGLE_GENERATIVE_AI_API_KEY` ✓ (Gemini)
- `BLOB_READ_WRITE_TOKEN` ✓ (Vercel Blob)

### npm run test — PASS (after fix)
- **Bug found:** `vitest.config.ts` lacked `exclude: ["e2e/**"]` — Playwright specs were being picked up by vitest, causing 2 spurious failures
- **Fix:** Added exclude. All 51 unit tests now clean across 7 files.

### tsc --noEmit — PASS (after fix)
- **Bug found:** `next.config.ts` had `serverActions` at top level; Next.js 16 requires it under `experimental`
- **Fix:** Moved to `experimental.serverActions`. Zero TS errors.

### npm run dev — PASS
- Dev server starts in 368ms on port 3000
- Neon DB connected (job list loaded from real DB)

### Real Filled-Form Import Proof — PASS
File used: `InspectionForm.pdf` (203 KB, from Downloads)

1. **Created** job "RealProof-InspectionTest" ✓
2. **Opened** Import from Paper panel ✓
3. **Uploaded** real PDF via Upload PDF button ✓
4. **Gemini extraction** returned 5 answers (real API call, no mock):
   - Pool Type → "Pool" (edited to "Pool/Spa Combo (Shared)")
   - Pump Installed → true
   - Filter Installed → true
   - Heater Installed → false
   - Lights Installed → false
5. **Edited** Pool Type in review panel before applying ✓
6. **Applied** — toast "5 answers imported from paper" ✓
7. **Form populated** — Pool Type select shows edited value, checkboxes match ✓
8. **Auto-saved** — "Saved" indicator visible immediately after apply ✓
9. **Reloaded** page — all 5 values persisted correctly from Neon DB ✓

### Original Scan in Photos — NOT IMPLEMENTED
The import-from-paper flow does not save the scan as a job photo. `ImportFromPaper` component only does field extraction. This was never implemented. Not a regression — never existed.

### Playwright E2E — PASS (2/2)
- smoke.spec.ts ✓
- import-from-paper.spec.ts ✓

### Branding — COMPLETE
- **Logo found:** PoolSmith's Renovations LLC PNG extracted from `InspectionForm.docx`
- **PDF:** Real logo embedded via `doc.addImage()` with text fallback
- **App icons:** `icon-192.png` + `icon-512.png` generated from logo (fixes manifest 404)

## Remaining Blockers

1. **Scan-as-photo not implemented** — `verify original scan appears in Photos` cannot pass. Requires uploading the scanned image to Vercel Blob and calling `savePhotoMetadata`. Out of scope for this proof pass.
2. **Email not verified in real environment** — submit flow requires signature; not tested end-to-end with real Resend send.

## Ship Verdict

**NOT YET SHIP-READY** — one proof step blocked (scan-as-photo), email delivery unverified.

**All code-correctness gates pass:** tests, types, E2E, real AI extraction, persistence.
