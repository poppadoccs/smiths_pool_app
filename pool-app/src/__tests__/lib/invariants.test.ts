import { describe, it, expect } from "vitest";
import { checkJobInvariants } from "@/lib/invariants";
import {
  ADDITIONAL_PHOTOS_FIELD_ID,
  RESERVED_PHOTO_MAP_KEY,
} from "@/lib/multi-photo";

const Q5 = "5_picture_of_pool_and_spa_if_applicable";
const Q16 = "16_photo_of_pool_pump";
const Q108 = ADDITIONAL_PHOTOS_FIELD_ID;
const REMARKS_15_PHOTOS = "15_remarks_notes_photos";

function photo(url: string) {
  return {
    url,
    filename: url.split("/").pop() ?? url,
    size: 1,
    uploadedAt: "2026-04-20",
  };
}

describe("checkJobInvariants — one-photo-one-owner", () => {
  it("passes a clean single-owner assignment", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["u1"] },
        [Q5]: "u1", // legitimate map+mirror for the same field id
      },
      photos: [photo("u1")],
    });
    expect(findings.filter((f) => f.severity === "violation")).toEqual([]);
  });

  it("flags a URL held by two distinct map owners", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: {
          [Q5]: ["shared"],
          [Q16]: ["shared"],
        },
      },
      photos: [photo("shared")],
    });
    const violations = findings.filter(
      (f) => f.invariant === "one-photo-one-owner",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].url).toBe("shared");
    expect(new Set(violations[0].owners)).toEqual(new Set([Q5, Q16]));
  });

  it("flags the exact pre-slice Q108 contamination we caught live", () => {
    // Reproduces the state we actually found in the 'test #1234' job:
    // remarks_15 has the URL via map, Q108 has it via legacy mirror.
    const findings = checkJobInvariants({
      id: "test-job",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: {
          [REMARKS_15_PHOTOS]: ["http://test/contaminated_url"],
        },
        [Q108]: "http://test/contaminated_url",
      },
      photos: [photo("http://test/contaminated_url")],
    });
    const violations = findings.filter((f) => f.severity === "violation");
    expect(violations.length).toBeGreaterThan(0);
    const dupeViolation = violations.find(
      (f) => f.invariant === "one-photo-one-owner",
    );
    expect(dupeViolation?.url).toBe("http://test/contaminated_url");
    expect(new Set(dupeViolation?.owners)).toEqual(
      new Set([REMARKS_15_PHOTOS, Q108]),
    );
  });

  it("does NOT flag a map+mirror pair that both point to the same URL for the same field id", () => {
    // One logical owner, two shapes — this is the contract for
    // multi-photo fields (Q5/Q16/...): map has [u0, u1], mirror = u0.
    const findings = checkJobInvariants({
      id: "j1",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["u0", "u1"] },
        [Q5]: "u0",
      },
      photos: [photo("u0"), photo("u1")],
    });
    expect(
      findings.filter((f) => f.invariant === "one-photo-one-owner"),
    ).toEqual([]);
  });
});

describe("checkJobInvariants — cap enforcement", () => {
  it("flags a Q5 bucket that exceeds its cap of 5", () => {
    const urls = Array.from({ length: 6 }, (_, i) => `u${i}`);
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [RESERVED_PHOTO_MAP_KEY]: { [Q5]: urls } },
      photos: urls.map(photo),
    });
    const capViolations = findings.filter(
      (f) => f.invariant === "cap-enforcement" && f.severity === "violation",
    );
    expect(capViolations).toHaveLength(1);
    expect(capViolations[0].owner).toBe(Q5);
  });

  it("passes a Q108 bucket exactly at cap (7)", () => {
    const urls = Array.from({ length: 7 }, (_, i) => `u${i}`);
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [RESERVED_PHOTO_MAP_KEY]: { [Q108]: urls } },
      photos: urls.map(photo),
    });
    expect(
      findings.filter(
        (f) => f.invariant === "cap-enforcement" && f.severity === "violation",
      ),
    ).toEqual([]);
  });

  it("flags an unknown map owner id as info (not a violation)", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [RESERVED_PHOTO_MAP_KEY]: { rogue_owner: ["u"] } },
      photos: [photo("u")],
    });
    const capFindings = findings.filter(
      (f) => f.invariant === "cap-enforcement",
    );
    expect(capFindings).toHaveLength(1);
    expect(capFindings[0].severity).toBe("info");
  });
});

describe("checkJobInvariants — ghost references", () => {
  it("flags a map entry whose URL is not in job.photos", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [RESERVED_PHOTO_MAP_KEY]: { [Q5]: ["ghost"] } },
      photos: [], // ghost URL never uploaded
    });
    const ghost = findings.filter((f) => f.invariant === "no-ghost-references");
    expect(ghost).toHaveLength(1);
    expect(ghost[0].url).toBe("ghost");
  });

  it("flags a legacy mirror whose URL is not in job.photos", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [Q5]: "http://ghost.example/x.jpg" },
      photos: [],
    });
    const ghost = findings.filter((f) => f.invariant === "no-ghost-references");
    expect(ghost).toHaveLength(1);
    expect(ghost[0].owner).toBe(Q5);
  });
});

describe("checkJobInvariants — Q108 map-only contract", () => {
  it("flags a stale Q108 mirror as info, not violation", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [Q108]: "http://test/u1" },
      photos: [photo("http://test/u1")],
    });
    const q108 = findings.filter(
      (f) => f.invariant === "q108-map-only-contract",
    );
    expect(q108).toHaveLength(1);
    expect(q108[0].severity).toBe("info");
  });

  it("flags a Q108 where map and mirror disagree as a real violation", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: {
        [RESERVED_PHOTO_MAP_KEY]: { [Q108]: ["http://test/u_map"] },
        [Q108]: "http://test/u_mirror", // differs from map
      },
      photos: [photo("http://test/u_map"), photo("http://test/u_mirror")],
    });
    const disagreements = findings.filter(
      (f) =>
        f.invariant === "q108-map-only-contract" && f.severity === "violation",
    );
    expect(disagreements).toHaveLength(1);
  });

  it("does NOT flag a Q108 that's map-only (post-slice contract holds)", () => {
    const findings = checkJobInvariants({
      id: "j1",
      formData: { [RESERVED_PHOTO_MAP_KEY]: { [Q108]: ["u1"] } },
      photos: [photo("u1")],
    });
    expect(
      findings.filter((f) => f.invariant === "q108-map-only-contract"),
    ).toEqual([]);
  });
});

describe("checkJobInvariants — fuzzing", () => {
  // Lightweight property-based test: generate N random assignment
  // sequences and assert the one-photo-one-owner invariant holds after
  // each stealOneOwner-like application. Because the dedicated server
  // actions enforce stealOneOwner internally, this fuzzer operates on
  // the PURE invariant: given any legal final state (one URL -> at most
  // one logical owner), checkJobInvariants must not flag a violation.
  // The test therefore constructs known-legal random states and proves
  // the checker doesn't produce false positives.
  it("no false positives on 500 randomly generated single-owner states", () => {
    const OWNERS = [
      Q5,
      Q16,
      Q108,
      REMARKS_15_PHOTOS,
      "71_picture_of_leaks_on_valves_if_applicable",
    ];
    for (let trial = 0; trial < 500; trial++) {
      const urlCount = 1 + Math.floor(Math.random() * 6);
      const urls = Array.from(
        { length: urlCount },
        (_, i) => `t${trial}_u${i}`,
      );
      // Assign each URL to exactly one owner.
      const map: Record<string, string[]> = {};
      for (const u of urls) {
        const owner = OWNERS[Math.floor(Math.random() * OWNERS.length)];
        (map[owner] ||= []).push(u);
      }
      // Mirror for the multi-photo fields (Q5/Q16): urls[0] of the bucket.
      const mirrors: Record<string, string> = {};
      for (const owner of [Q5, Q16]) {
        if (map[owner] && map[owner].length > 0) {
          mirrors[owner] = map[owner][0];
        }
      }
      const findings = checkJobInvariants({
        id: `fuzz-${trial}`,
        formData: {
          [RESERVED_PHOTO_MAP_KEY]: map,
          ...mirrors,
        },
        photos: urls.map(photo),
      });
      const violations = findings.filter(
        (f) => f.invariant === "one-photo-one-owner",
      );
      if (violations.length > 0) {
        throw new Error(
          `Fuzz trial ${trial} produced false positive: ${JSON.stringify(violations)} | state: ${JSON.stringify(map)}`,
        );
      }
    }
  });

  it("always detects a violation when the fuzzer injects a cross-owner duplicate", () => {
    for (let trial = 0; trial < 500; trial++) {
      const OWNERS = [Q5, Q16, Q108, REMARKS_15_PHOTOS];
      // Pick two distinct owners and share a URL between them.
      const [a, b] = [
        OWNERS[Math.floor(Math.random() * OWNERS.length)],
        OWNERS[Math.floor(Math.random() * OWNERS.length)],
      ];
      if (a === b) continue; // skip trial; fuzzer can collide
      const sharedUrl = `shared_${trial}`;
      const map: Record<string, string[]> = {
        [a]: [sharedUrl],
        [b]: [sharedUrl],
      };
      const findings = checkJobInvariants({
        id: `fuzz-${trial}`,
        formData: { [RESERVED_PHOTO_MAP_KEY]: map },
        photos: [photo(sharedUrl)],
      });
      const violations = findings.filter(
        (f) => f.invariant === "one-photo-one-owner",
      );
      if (violations.length === 0) {
        throw new Error(
          `Fuzz trial ${trial} missed injected duplicate: owners=${a},${b}`,
        );
      }
    }
  });
});
