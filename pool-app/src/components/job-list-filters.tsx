"use client";

import { useState } from "react";
import { JobCard } from "@/components/job-card";
import { JobList } from "@/components/job-list";
import type { Job } from "@/generated/prisma/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Dumb filter shell: owns the search-query + status-choice UI state,
// renders the two controls, then either delegates to <JobList> (when no
// filter is active — preserves JobList's own raw-empty state exactly) or
// renders the filtered card list inline with its own filter-specific
// empty state. Intentionally no sort/grouping/pagination/URL-sync.

type StatusFilter = "ALL" | "DRAFT" | "SUBMITTED";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
];

export function JobListFilters({ jobs }: { jobs: Job[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const isFiltering = q.trim() !== "" || status !== "ALL";

  // Counts come from the unfiltered `jobs` prop so badges show how many
  // exist in each bucket, not how many are currently visible. Page already
  // filters out ARCHIVED server-side, so DRAFT + SUBMITTED === ALL holds.
  const counts: Record<StatusFilter, number> = {
    ALL: jobs.length,
    DRAFT: jobs.filter((j) => j.status === "DRAFT").length,
    SUBMITTED: jobs.filter((j) => j.status === "SUBMITTED").length,
  };

  const needle = q.trim().toLowerCase();
  const filtered = !isFiltering
    ? jobs
    : jobs.filter((j) => {
        if (status !== "ALL" && j.status !== status) return false;
        if (!needle) return true;
        const hay = `${j.name ?? ""} ${j.jobNumber ?? ""}`.toLowerCase();
        return hay.includes(needle);
      });

  return (
    <div className="mt-4 space-y-4">
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name or job #"
        autoComplete="off"
        className="min-h-[48px] text-base"
      />
      <div className="flex gap-2">
        {STATUS_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            variant={status === opt.value ? "default" : "outline"}
            onClick={() => setStatus(opt.value)}
            className="min-h-[48px] flex-1 text-base"
          >
            {opt.label} ({counts[opt.value]})
          </Button>
        ))}
      </div>

      {isFiltering ? (
        filtered.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-lg text-zinc-500">No jobs match this filter.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((j) => (
              <JobCard key={j.id} job={j} />
            ))}
          </div>
        )
      ) : (
        <JobList jobs={jobs} />
      )}
    </div>
  );
}
