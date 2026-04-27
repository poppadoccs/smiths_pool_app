"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createEditableCopy } from "@/lib/actions/jobs";

// Button shown on submitted-job pages that creates a DRAFT copy of the
// source job and navigates to the new copy. No email, no mutation of the
// source record — see createEditableCopy for the server-side contract.
export function EditableCopyButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      onClick={() =>
        startTransition(async () => {
          const res = await createEditableCopy(jobId);
          if (!res.success || !res.newJobId) {
            toast.error(res.error ?? "Failed to create editable copy");
            return;
          }
          toast.success("Editable copy created");
          router.push(`/jobs/${res.newJobId}`);
        })
      }
      disabled={isPending}
      className="min-h-[48px] gap-2 text-base"
    >
      {isPending ? (
        <Loader2 className="size-5 animate-spin" />
      ) : (
        <Copy className="size-5" />
      )}
      Resend or edit (create copy)
    </Button>
  );
}
