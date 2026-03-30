"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Copy, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { duplicateTemplate, deleteTemplate } from "@/lib/actions/templates";

type TemplateCardProps = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  fieldCount: number;
  jobCount: number;
};

export function TemplateCard({
  id,
  name,
  description,
  isDefault,
  fieldCount,
  jobCount,
}: TemplateCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  async function handleDuplicate(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    const result = await duplicateTemplate(id);
    if (result.success) {
      toast.success("Template duplicated");
      router.refresh();
    } else {
      toast.error(result.error || "Failed to duplicate");
    }
    setBusy(false);
  }

  async function handleDelete() {
    setBusy(true);
    setDeleteOpen(false);
    const result = await deleteTemplate(id);
    if (result.success) {
      toast.success("Template deleted");
      router.refresh();
    } else {
      toast.error(result.error || "Failed to delete");
    }
    setBusy(false);
  }

  return (
    <>
      <Card
        className="cursor-pointer transition-colors active:bg-zinc-100"
        onClick={() => router.push(`/templates/${id}/edit`)}
      >
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-lg font-medium text-zinc-900">
                  {name}
                </p>
                {isDefault && (
                  <span className="shrink-0 rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
                    Default
                  </span>
                )}
              </div>
              {description && (
                <p className="truncate text-sm text-zinc-500">{description}</p>
              )}
              <p className="text-sm text-zinc-400">
                {fieldCount} field{fieldCount !== 1 ? "s" : ""}
                {jobCount > 0 &&
                  ` · ${jobCount} job${jobCount !== 1 ? "s" : ""}`}
              </p>
            </div>

            <div className="ml-3 flex shrink-0 items-center gap-1">
              {busy && <Loader2 className="size-4 animate-spin text-zinc-400" />}
              <Button
                variant="ghost"
                size="sm"
                className="size-9 p-0"
                disabled={busy}
                onClick={handleDuplicate}
              >
                <Copy className="size-4" />
              </Button>
              {!isDefault && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-9 p-0 text-red-500 hover:text-red-700"
                  disabled={busy}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {jobCount > 0
                ? `This template is used by ${jobCount} job(s). You must remove them before deleting.`
                : "This template will be permanently deleted. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]">
              Cancel
            </AlertDialogCancel>
            {jobCount === 0 && (
              <AlertDialogAction
                className="min-h-[44px] bg-red-600 hover:bg-red-700 text-white"
                onClick={handleDelete}
              >
                Yes, Delete
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
