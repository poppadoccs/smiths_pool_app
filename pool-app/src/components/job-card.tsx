"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { formatDistanceToNow } from "date-fns";
import type { Job } from "@/generated/prisma/client";

export function JobCard({ job }: { job: Job }) {
  const displayName = job.name || `Job #${job.jobNumber}`;

  return (
    <Link href={`/jobs/${job.id}`} className="block">
      <Card className="min-h-[56px] transition-colors active:bg-zinc-100">
        <CardContent className="flex items-center justify-between p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-medium text-zinc-900">
              {displayName}
            </p>
            {job.name && job.jobNumber && (
              <p className="text-sm text-zinc-600">#{job.jobNumber}</p>
            )}
            <p className="text-sm text-zinc-500">
              {formatDistanceToNow(job.createdAt, { addSuffix: true })}
            </p>
          </div>
          <div className="ml-4 shrink-0">
            <StatusBadge status={job.status} />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
