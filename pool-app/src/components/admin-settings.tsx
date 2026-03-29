"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Lock,
  Check,
  Loader2,
  Archive,
  Trash2,
  KeyRound,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import {
  verifyPin,
  saveRecipientEmail,
  changePin,
  archiveJob,
  deleteJob,
} from "@/lib/actions/settings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import Link from "next/link";

type ManagedJob = {
  id: string;
  name: string | null;
  jobNumber: string | null;
  status: string;
  submittedBy: string | null;
  submittedAt: Date | null;
};

function statusLabel(status: string) {
  if (status === "SUBMITTED") return "Submitted";
  if (status === "ARCHIVED") return "Archived";
  return "Draft";
}

export function AdminSettings({
  currentEmail,
  allJobs,
}: {
  currentEmail: string;
  allJobs: ManagedJob[];
}) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pinError, setPinError] = useState("");

  // Email state
  const [email, setEmail] = useState(currentEmail);
  const [saving, setSaving] = useState(false);

  // PIN change state
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [changingPin, setChangingPin] = useState(false);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);

  // Job action state
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [archiveDialogJob, setArchiveDialogJob] = useState<string | null>(
    null
  );
  const [deleteDialogJob, setDeleteDialogJob] = useState<string | null>(null);

  async function handleUnlock() {
    setChecking(true);
    setPinError("");
    const result = await verifyPin(pin);
    if (result.valid) {
      setUnlocked(true);
    } else {
      setPinError("Wrong PIN. Try again.");
    }
    setChecking(false);
  }

  async function handleSaveEmail() {
    setSaving(true);
    const result = await saveRecipientEmail(pin, email);
    if (result.success) {
      toast.success("Email updated!");
    } else {
      toast.error(result.error || "Failed to save");
    }
    setSaving(false);
  }

  async function handleChangePin() {
    if (newPin !== confirmPin) {
      toast.error("New PINs don't match");
      setPinDialogOpen(false);
      return;
    }
    setChangingPin(true);
    setPinDialogOpen(false);
    const result = await changePin(pin, newPin);
    if (result.success) {
      toast.success("PIN changed!");
      setPin(newPin);
      setNewPin("");
      setConfirmPin("");
    } else {
      toast.error(result.error || "Failed to change PIN");
    }
    setChangingPin(false);
  }

  async function handleArchive(jobId: string) {
    setBusyJob(jobId);
    setArchiveDialogJob(null);
    const result = await archiveJob(pin, jobId);
    if (result.success) {
      toast.success("Job archived");
      router.refresh();
    } else {
      toast.error(result.error || "Failed to archive");
    }
    setBusyJob(null);
  }

  async function handleDelete(jobId: string) {
    setBusyJob(jobId);
    setDeleteDialogJob(null);
    const result = await deleteJob(pin, jobId);
    if (result.success) {
      toast.success("Job permanently deleted");
      router.refresh();
    } else {
      toast.error(result.error || "Failed to delete");
    }
    setBusyJob(null);
  }

  if (!unlocked) {
    return (
      <Card className="mt-6">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2 text-zinc-600">
            <Lock className="size-5" />
            <span className="text-base font-medium">Enter admin PIN</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-pin" className="text-base">
              PIN
            </Label>
            <Input
              id="admin-pin"
              type="password"
              inputMode="numeric"
              placeholder="Enter PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pin.trim()) handleUnlock();
              }}
              className="min-h-[48px] text-lg text-center tracking-widest"
            />
            {pinError && (
              <p className="text-sm text-red-600">{pinError}</p>
            )}
          </div>
          <Button
            className="w-full min-h-[48px] text-base"
            disabled={!pin.trim() || checking}
            onClick={handleUnlock}
          >
            {checking ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Unlock Settings"
            )}
          </Button>
          <Link href="/">
            <Button
              variant="ghost"
              className="w-full min-h-[48px] text-base text-zinc-500"
            >
              Back to Jobs
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {/* Job Management */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2 text-zinc-700">
            <Archive className="size-5" />
            <span className="text-base font-semibold">
              Manage Jobs ({allJobs.length})
            </span>
          </div>

          {allJobs.length === 0 ? (
            <p className="text-sm text-zinc-500 py-2">No jobs to manage.</p>
          ) : (
            <div className="space-y-2">
              {allJobs.map((job) => {
                const displayName =
                  job.name || `Job #${job.jobNumber}` || "Untitled";
                const isBusy = busyJob === job.id;
                const canArchive = job.status === "SUBMITTED";
                const deleteWarning =
                  job.status === "SUBMITTED"
                    ? "This job was submitted and emailed. Deleting it removes all data and photos permanently. This cannot be undone."
                    : "This will permanently delete the job and all its photos. This cannot be undone.";

                return (
                  <div
                    key={job.id}
                    className="rounded-lg border border-zinc-200 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900">
                          {displayName}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {statusLabel(job.status)}
                          {job.submittedBy && ` · by ${job.submittedBy}`}
                        </p>
                      </div>
                      {isBusy && (
                        <Loader2 className="size-4 animate-spin text-zinc-400 ml-2" />
                      )}
                    </div>

                    <div className="mt-2 flex gap-2">
                      {canArchive && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-h-[40px] flex-1"
                          disabled={isBusy}
                          onClick={() => setArchiveDialogJob(job.id)}
                        >
                          <Archive className="size-4 mr-1.5" />
                          Archive
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-[40px] flex-1 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                        disabled={isBusy}
                        onClick={() => setDeleteDialogJob(job.id)}
                      >
                        <Trash2 className="size-4 mr-1.5" />
                        Delete
                      </Button>
                    </div>

                    {/* Archive confirmation */}
                    <AlertDialog
                      open={archiveDialogJob === job.id}
                      onOpenChange={(open) => {
                        if (!open) setArchiveDialogJob(null);
                      }}
                    >
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Archive &ldquo;{displayName}&rdquo;?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This hides the job from the main list. The data is
                            kept safe — nothing is deleted.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="min-h-[44px]">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            className="min-h-[44px]"
                            onClick={() => handleArchive(job.id)}
                          >
                            Yes, Archive
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>

                    {/* Delete confirmation — stronger warning */}
                    <AlertDialog
                      open={deleteDialogJob === job.id}
                      onOpenChange={(open) => {
                        if (!open) setDeleteDialogJob(null);
                      }}
                    >
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Permanently delete &ldquo;{displayName}&rdquo;?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {deleteWarning}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="min-h-[44px]">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            className="min-h-[44px] bg-red-600 hover:bg-red-700 text-white"
                            onClick={() => handleDelete(job.id)}
                          >
                            Yes, Delete Forever
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Email Setting */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2 text-zinc-700">
            <Mail className="size-5" />
            <span className="text-base font-semibold">Submission Email</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recipient-email" className="text-base">
              Send submissions to
            </Label>
            <Input
              id="recipient-email"
              type="email"
              inputMode="email"
              placeholder="office@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-[48px] text-base"
            />
            <p className="text-sm text-zinc-500">
              Job submissions will be emailed to this address.
            </p>
          </div>
          <Button
            className="w-full min-h-[48px] gap-2 text-base"
            disabled={!email.trim() || saving}
            onClick={handleSaveEmail}
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Check className="size-4" />
                Save Email
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* PIN Change */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2 text-zinc-700">
            <KeyRound className="size-5" />
            <span className="text-base font-semibold">Change PIN</span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pin" className="text-base">
              New PIN
            </Label>
            <Input
              id="new-pin"
              type="password"
              inputMode="numeric"
              placeholder="Enter new PIN"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              className="min-h-[48px] text-lg text-center tracking-widest"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-pin" className="text-base">
              Confirm New PIN
            </Label>
            <Input
              id="confirm-pin"
              type="password"
              inputMode="numeric"
              placeholder="Confirm new PIN"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className="min-h-[48px] text-lg text-center tracking-widest"
            />
          </div>
          <Button
            variant="outline"
            className="w-full min-h-[48px] gap-2 text-base"
            disabled={!newPin.trim() || !confirmPin.trim() || changingPin}
            onClick={() => setPinDialogOpen(true)}
          >
            {changingPin ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Changing...
              </>
            ) : (
              <>
                <KeyRound className="size-4" />
                Change PIN
              </>
            )}
          </Button>
          <p className="text-sm text-zinc-500">
            PIN must be at least 4 digits, numbers only.
          </p>

          <AlertDialog
            open={pinDialogOpen}
            onOpenChange={setPinDialogOpen}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Change admin PIN?</AlertDialogTitle>
                <AlertDialogDescription>
                  Make sure you remember the new PIN. You&apos;ll need it to
                  access settings.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="min-h-[44px]">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="min-h-[44px]"
                  onClick={handleChangePin}
                >
                  Yes, Change PIN
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>

      {/* Back link */}
      <Link href="/">
        <Button
          variant="ghost"
          className="w-full min-h-[48px] text-base text-zinc-500"
        >
          Back to Jobs
        </Button>
      </Link>
    </div>
  );
}
