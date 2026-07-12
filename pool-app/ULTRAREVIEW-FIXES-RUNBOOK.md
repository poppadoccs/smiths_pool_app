# Ultrareview fix wave — runbook (2026-07-11)

Branch: `pool/ultrareview-fixes` (from main 2b333e9). All 7 cloud-review findings
verified REAL against code. All are PRE-EXISTING bugs (not from the Cassandra/PR-4/PR-5 work).
After all fixes: full test suite + build, push, PR, Alex merges ("merge PR #N").
Test baseline before wave: 310 passing.

## Status

- [x] 1. bug_001 `photos.ts` savePhotoMetadata — added `AND status::text = 'DRAFT'` + error msg. DONE (uncommitted).
- [ ] 2. bug_013 `settings.ts` archiveJob — replace findUnique+check+update with atomic
     `updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "ARCHIVED" } })`;
     `count===0` → "Only submitted jobs can be archived". Mirror reopenJob (lines 114-142).
- [ ] 3. bug_003 `settings.ts` deleteJob (lines 144-170) — two guards before blob del():
     (a) if `isEditableCopy(job.formData)` → still delete ROW but SKIP blob deletion (blobs belong to source);
     (b) else check for living copies: `db.job.findFirst({ where: { formData: { path: ["__sourceJobId"], equals: jobId } } })`
     → if found, SKIP blob deletion, still delete row. Import isEditableCopy from @/lib/multi-photo.
     Plain jobs keep current behavior (del blobs + row).
- [ ] 4. bug_010 `submit.ts` — line ~62: keep SUBMITTED-specific msg, add
     `if (job.status !== "DRAFT") return { success:false, error: "This job is archived and cannot be submitted" }`;
     line ~138 updateMany where → `status: "DRAFT"`.
     TEST UPDATE: submit.test.ts asserts `where: { id: "job-1", status: { not: "SUBMITTED" } }` → change to `status: "DRAFT"`; add ARCHIVED-rejection test.
- [ ] 5. merged_bug_011 `scan.ts` — two regex fixes:
     (a) line ~267 `LICENSE_STANDALONE_RE` = `/^(?:licen[sc]e|cert(?:ification)?)\s+[A-Z0-9]{4,}/i`
     → require a digit: `/^(?:licen[sc]e|cert(?:ification)?)\s+[A-Z0-9]*\d[A-Z0-9]*/i`
     (kills "License CPC1459862", spares "License Number/Type/Class").
     (b) line ~923 extractHelperText: `/\s*\((?:e\.?g\.?|ex|example|hint|note)[:\s,.]*([^)]+)\)\s*$/i`
     → add `\b` after alternation: `(?:e\.?g\.?|ex|example|hint|note)\b`
     (spares "(exact measurement)", "(extra details)", "(examples of ...)").
- [ ] 6. bug_002 `photos.ts` deletePhoto — after photos-array rewrite, ALSO strip URL from formData:
     Approach: findUnique include template (photo-type field ids). Pure helper
     `stripPhotoReferences(formData, url, photoFieldIds)` (new, put near multi-photo or in photos lib; unit-test it):
     - remove url from every array under `__photoAssignmentsByField` (drop key if empty);
     - for each photoFieldId: if formData[id] === url → "";
     - `__summary_items`: filter url out of each item.photos.
       Write via jsonb-merge patch of ONLY changed keys (map key + touched mirrors + \_\_summary_items) in the SAME
       guarded UPDATE style (`AND status::text = 'DRAFT'` — deletePhoto already refuses SUBMITTED/copies pre-check).
       If nothing references the url, skip the second write.
- [ ] 7. bug_006 `photo-assignments.ts` — convert 4 actions from full-formData `updateMany` replace to
     atomic jsonb-merge patch (mirror saveFormData forms.ts:94-99):
     - stealOneOwner signature: (currentMap, existing READ-ONLY, patch WRITE, templatePhotoFieldIds, targetFieldId, incomingUrls).
       Pass 1 mirror-sync writes to patch; Pass 2 reads `patch[fid] !== undefined ? patch[fid] : existing[fid]`, writes patch[fid]="".
     - Each action: build patch{} → steal → patch[RESERVED_PHOTO_MAP_KEY]=currentMap; patch[REVIEWED_FLAG]=true;
       assignMultiField also patch[fieldId]=unique[0]??""; savePhotoAssignments: patch[each legacyPhotoFieldId]=mirror value (its bulk contract).
     - Write: db.$executeRaw UPDATE jobs SET form_data = COALESCE(form_data,'{}'::jsonb) || ${patchJson}::jsonb WHERE id=${jobId} AND status::text='DRAFT';
       affected===0 → "Job is no longer editable".
     - KNOWN LIMIT (document in comment): map is one jsonb key — two simultaneous assign actions still race each other
       (same as today); the fix protects autosave text keys + \_\_summary_items from being clobbered.
       TEST REWORK photo-assignments.test.ts: add `$executeRaw: vi.fn().mockResolvedValue(1)` to db mock;
       `writtenFormData()` (line 50) → parse JSON from last $executeRaw call: `calls[last][1]` (tagged template: [strings, patchJson, jobId]);
       replace `updateMany` mockResolvedValue/not.toHaveBeenCalled/count-0 assertions with $executeRaw equivalents (mock 0 for count-0 tests);
       any "preserves key X" assertions flip to "patch does NOT contain X" (preservation is by construction now).

## After all fixes

- npx tsc --noEmit; npx eslint changed files; npm test (expect 310+ green after test rework);
- new tests: savePhotoMetadata guard; archiveJob atomic; deleteJob copy/source guards; submit ARCHIVED; stripPhotoReferences unit; scan regex (export or test indirectly);
- commit per logical fix; push -u origin pool/ultrareview-fixes; gh pr create (base main) with triage table (7/7 real, all pre-existing); preview build; Alex says "merge PR #N".
- Cleanup after merge: delete review/whole-app + review/core branches; delete this runbook file.
- Findings source: task ruesb5mfj (ultrareview session https://claude.ai/code/session_014R2dPKig7RwqWYqTRKUa5t).
