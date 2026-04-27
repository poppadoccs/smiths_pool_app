"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Send, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { submitJob } from "@/lib/actions/submit";
import { clearDraft } from "@/components/job-form";
import { SignaturePad } from "@/components/signature-pad";

export function SubmitSection({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [signatureData, setSignatureData] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // Tracks whether the office email actually sent. Undefined until a submit
  // result arrives; then true on happy path, false when the server flipped
  // the job to SUBMITTED but Resend returned an error.
  const [emailSent, setEmailSent] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);

    const result = await submitJob(
      jobId,
      name.trim(),
      signatureData || undefined,
    );

    if (result.success) {
      clearDraft(jobId);
      setEmailSent(result.emailSent !== false);
      setSubmitted(true);
      setShowConfirm(false);
      if (result.emailSent === false) {
        toast.warning("Job saved, but the email didn't send.");
      } else {
        toast.success("Job submitted for review!");
      }
      router.refresh();
    } else {
      setError(result.error || "Submission failed");
      setShowConfirm(false);
      setSubmitting(false);
    }
  }

  if (submitted) {
    if (emailSent) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-6 text-center">
          <CheckCircle2 className="size-10 text-green-600" />
          <h3 className="text-lg font-semibold text-green-800">
            Submitted for Review
          </h3>
          <p className="text-base text-green-700">
            The form and photos have been emailed to the office.
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-6 text-center">
        <AlertTriangle className="size-10 text-amber-600" />
        <h3 className="text-lg font-semibold text-amber-800">
          Submitted — email didn&apos;t send
        </h3>
        <p className="text-base text-amber-700">
          The job is saved, but the office email didn&apos;t go through. Please
          let them know directly, or resend from the submitted job view.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="submitter-name" className="text-base">
          Your Name <span className="text-red-500">*</span>
        </Label>
        <Input
          id="submitter-name"
          placeholder="e.g., Mike"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-h-[48px] text-base"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-base">
          Signature <span className="text-red-500">*</span>
        </Label>
        <p className="text-sm text-zinc-500">Sign with your finger below</p>
        <SignaturePad onEnd={setSignatureData} />
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-base text-red-700">
          {error}
        </p>
      )}

      <Button
        type="button"
        className="min-h-[56px] w-full gap-2 text-lg font-semibold"
        disabled={!name.trim() || !signatureData || submitting}
        onClick={() => setShowConfirm(true)}
      >
        <Send className="size-5" />
        Submit for Review
      </Button>

      <Dialog
        open={showConfirm}
        onOpenChange={(open) => {
          if (!open && !submitting) setShowConfirm(false);
        }}
      >
        <DialogContent className="sm:max-w-md" showCloseButton={!submitting}>
          <DialogTitle>Submit this job?</DialogTitle>
          <DialogDescription className="text-base">
            This will email the form and photos to the office for review. You
            won&apos;t be able to edit the form after submitting.
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-[48px] text-base"
              disabled={submitting}
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-[48px] gap-2 text-base"
              disabled={submitting}
              onClick={handleSubmit}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Yes, Submit"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
