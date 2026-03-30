"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";
import { createJob } from "@/lib/actions/jobs";
import { toast } from "sonner";

type TemplateSummary = { id: string; name: string };

export function CreateJobForm({
  templates,
}: {
  templates: TemplateSummary[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [state, formAction, pending] = useActionState(createJob, null);

  useEffect(() => {
    if (state?.success) {
      toast.success("Job created");
      setIsOpen(false);
    }
  }, [state]);

  if (!isOpen) {
    return (
      <Button
        onClick={() => setIsOpen(true)}
        className="mt-4 w-full min-h-[56px] text-lg"
      >
        <Plus className="mr-2 size-5" />
        New Job
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      className="mt-4 space-y-3 rounded-lg border border-zinc-300 bg-zinc-50 p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">New Job</h2>
        <Button
          type="button"
          variant="ghost"
          className="min-h-[48px] min-w-[48px]"
          onClick={() => setIsOpen(false)}
        >
          <X className="size-5" />
        </Button>
      </div>
      <Input
        name="name"
        placeholder="Job name (e.g., Smith Residence)"
        className="min-h-[48px] text-base"
      />
      <Input
        name="jobNumber"
        placeholder="Job number (e.g., 2024-042)"
        className="min-h-[48px] text-base"
      />
      {templates.length > 0 && (
        <div className="space-y-1">
          <Label className="text-sm text-zinc-600">Form Template</Label>
          <Select
            value={selectedTemplate}
            onValueChange={(val) => setSelectedTemplate(val ?? "")}
          >
            <SelectTrigger className="min-h-[48px] text-base">
              <SelectValue placeholder="Default template" />
            </SelectTrigger>
            <SelectContent>
              {templates.map((tpl) => (
                <SelectItem
                  key={tpl.id}
                  value={tpl.id}
                  className="min-h-[44px] text-base"
                >
                  {tpl.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="templateId" value={selectedTemplate} />
        </div>
      )}
      {state?.error && (
        <p className="text-base font-medium text-red-600">{state.error}</p>
      )}
      <Button
        type="submit"
        disabled={pending}
        className="w-full min-h-[56px] text-lg font-semibold"
      >
        {pending ? "Creating..." : "Create Job"}
      </Button>
    </form>
  );
}
