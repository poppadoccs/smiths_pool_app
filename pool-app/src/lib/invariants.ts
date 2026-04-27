// Invariants for Pool Field Forms photo ownership.
//
// An invariant is a rule that must hold at ALL times about a job's state,
// regardless of which code path produced that state. Unlike a regression
// test (which catches one specific bug), an invariant catches every bug
// that violates the same rule — including ones not yet discovered.
//
// Rules encoded here are derived from product contracts, not bug reports:
//   - one-photo-one-owner (locked 2026-04-20)
//   - cap enforcement (locked 2026-04-20)
//   - no ghost references (every URL referenced in formData must exist
//     in job.photos — prevents dangling owner entries)
//   - Q108 post-slice contract (map-only, no mirror — informational flag
//     for historical contamination; does NOT fail the job since the steal
//     path self-heals on next write)
//
// Usage:
//   - scripts/invariants.ts sweeps the live DB and prints violations
//   - tests can exercise this module directly with synthetic inputs
//   - future consumers (e.g. resend/editable-copy) can precheck data
//     integrity before acting on a job

import {
  ADDITIONAL_PHOTOS_CAP,
  ADDITIONAL_PHOTOS_FIELD_ID,
  MULTI_PHOTO_CAPS,
  MULTI_PHOTO_FIELD_IDS,
  REMARKS_PHOTO_CAP,
  REMARKS_PHOTO_FIELD_IDS,
  RESERVED_PHOTO_MAP_KEY,
} from "@/lib/multi-photo";
import type { FormData } from "@/lib/forms";
import type { PhotoMetadata } from "@/lib/photos";

export type Severity = "violation" | "info";

export type Invariant =
  | "one-photo-one-owner"
  | "cap-enforcement"
  | "no-ghost-references"
  | "q108-map-only-contract";

export type Finding = {
  invariant: Invariant;
  severity: Severity;
  message: string;
  // Human-readable detail for the report. Structured fields kept small on
  // purpose — a finding should be legible at a glance in the report.
  url?: string;
  owners?: string[];
  owner?: string;
};

export type JobLike = {
  id: string;
  name?: string | null;
  status?: string;
  formData: FormData | null;
  photos: PhotoMetadata[] | null;
};

// Main entry: run every invariant against one job and return the finding
// list. No throwing — callers decide how to react (fail CI, print report,
// page oncall, etc.).
export function checkJobInvariants(job: JobLike): Finding[] {
  const findings: Finding[] = [];
  const fd = job.formData ?? {};
  const photos = job.photos ?? [];

  const map = readMap(fd);
  const mirrors = readMirrors(fd);
  const photoUrlSet = new Set(photos.map((p) => p.url));

  findings.push(...checkOnePhotoOneOwner(map, mirrors));
  findings.push(...checkCaps(map));
  findings.push(...checkGhostReferences(map, mirrors, photoUrlSet));
  findings.push(...checkQ108Contract(map, mirrors));

  return findings;
}

// --- helpers ---

function readMap(fd: FormData): Record<string, string[]> {
  const raw = fd[RESERVED_PHOTO_MAP_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    out[k] = v.filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
  }
  return out;
}

function readMirrors(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fd)) {
    if (k.startsWith("__")) continue;
    if (typeof v !== "string") continue;
    if (!v.startsWith("http")) continue;
    out[k] = v;
  }
  return out;
}

// Rule: at any moment, no photo URL appears in more than one ownership
// location across (map buckets) + (legacy mirror keys). A map-backed
// field (Q5/Q16/Q25/Q40/Q71) legitimately has BOTH its map entry and its
// mirror pointing to the same URL — that is ONE logical owner expressed
// in two shapes — so the invariant groups map+mirror pairs for the same
// field id together before counting distinct owners.
function checkOnePhotoOneOwner(
  map: Record<string, string[]>,
  mirrors: Record<string, string>,
): Finding[] {
  // url -> set of logical owner ids (the field id, not the shape).
  const urlToOwners = new Map<string, Set<string>>();
  const add = (url: string, owner: string) => {
    let set = urlToOwners.get(url);
    if (!set) {
      set = new Set();
      urlToOwners.set(url, set);
    }
    set.add(owner);
  };

  for (const [owner, urls] of Object.entries(map)) {
    for (const u of urls) add(u, owner);
  }
  for (const [owner, u] of Object.entries(mirrors)) {
    add(u, owner);
  }

  const findings: Finding[] = [];
  for (const [url, owners] of urlToOwners) {
    if (owners.size > 1) {
      findings.push({
        invariant: "one-photo-one-owner",
        severity: "violation",
        message: `URL owned by multiple logical owners: ${[...owners].join(", ")}`,
        url,
        owners: [...owners],
      });
    }
  }
  return findings;
}

// Rule: no map bucket exceeds its product cap.
// Q5/Q16/Q25/Q40/Q71 caps come from MULTI_PHOTO_CAPS.
// Q108 cap is ADDITIONAL_PHOTOS_CAP. Remarks-photo owners cap at REMARKS_PHOTO_CAP.
// Any other map key is unexpected and flagged informationally.
function checkCaps(map: Record<string, string[]>): Finding[] {
  const findings: Finding[] = [];
  for (const [owner, urls] of Object.entries(map)) {
    let cap: number | undefined;
    if (MULTI_PHOTO_FIELD_IDS.has(owner)) {
      cap = MULTI_PHOTO_CAPS[owner];
    } else if (owner === ADDITIONAL_PHOTOS_FIELD_ID) {
      cap = ADDITIONAL_PHOTOS_CAP;
    } else if (REMARKS_PHOTO_FIELD_IDS.has(owner)) {
      cap = REMARKS_PHOTO_CAP;
    }
    if (cap === undefined) {
      findings.push({
        invariant: "cap-enforcement",
        severity: "info",
        message: `Unknown map owner id (no cap defined)`,
        owner,
      });
      continue;
    }
    if (urls.length > cap) {
      findings.push({
        invariant: "cap-enforcement",
        severity: "violation",
        message: `Owner has ${urls.length} photos, cap is ${cap}`,
        owner,
      });
    }
  }
  return findings;
}

// Rule: every URL referenced in formData (map + mirrors) must exist in
// job.photos. A reference to a URL not in photos is a ghost — the blob
// may still exist in storage but the job no longer owns it. This catches
// deletions that skipped the formData cleanup and uploads that raced
// against the form.
function checkGhostReferences(
  map: Record<string, string[]>,
  mirrors: Record<string, string>,
  photoUrlSet: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const [owner, urls] of Object.entries(map)) {
    for (const u of urls) {
      if (!photoUrlSet.has(u)) {
        findings.push({
          invariant: "no-ghost-references",
          severity: "violation",
          message: `Map owner references URL not in job.photos`,
          url: u,
          owner,
        });
      }
    }
  }
  for (const [owner, u] of Object.entries(mirrors)) {
    if (!photoUrlSet.has(u)) {
      findings.push({
        invariant: "no-ghost-references",
        severity: "violation",
        message: `Legacy mirror references URL not in job.photos`,
        url: u,
        owner,
      });
    }
  }
  return findings;
}

// Informational rule: post-slice contract says Q108 is map-only — no
// legacy mirror. Historical jobs can carry a stale mirror from the
// pre-slice PhotoFieldInput path. Flag it so operators know which jobs
// still carry contamination. NOT a violation: the steal path self-heals
// this mirror on any future write, and readFieldPhotoUrls prefers the
// map so the stale mirror is invisible once the map has an entry.
function checkQ108Contract(
  map: Record<string, string[]>,
  mirrors: Record<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  const q108Mirror = mirrors[ADDITIONAL_PHOTOS_FIELD_ID];
  if (q108Mirror) {
    findings.push({
      invariant: "q108-map-only-contract",
      severity: "info",
      message: `Q108 has a legacy mirror (pre-slice contamination; self-heals on next cross-owner steal)`,
      owner: ADDITIONAL_PHOTOS_FIELD_ID,
      url: q108Mirror,
    });
  }
  // If Q108 has BOTH a map entry and a mirror with a DIFFERENT URL, that's
  // a harder anomaly — the two shapes disagree. readFieldPhotoUrls prefers
  // map so the mirror is dead weight, but it indicates an inconsistent
  // write sequence somewhere.
  const q108Map = map[ADDITIONAL_PHOTOS_FIELD_ID] ?? [];
  if (q108Mirror && q108Map.length > 0 && !q108Map.includes(q108Mirror)) {
    findings.push({
      invariant: "q108-map-only-contract",
      severity: "violation",
      message: `Q108 map entry and legacy mirror disagree (mirror URL not in map)`,
      owner: ADDITIONAL_PHOTOS_FIELD_ID,
      url: q108Mirror,
    });
  }
  return findings;
}
