"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Camera,
  FileUp,
  Loader2,
  ScanLine,
  AlertTriangle,
  RotateCcw,
  X,
  FileText,
} from "lucide-react";
import { extractAnswersFromFilledForm } from "@/lib/actions/scan";
import type { FormField } from "@/lib/forms";
import imageCompression from "browser-image-compression";

type State = "idle" | "upload" | "scanning" | "review" | "error";

type ExtractedEntry = {
  fieldId: string;
  label: string;
  value: string;
};

export function ImportFromPaper({
  fields,
  onApply,
}: {
  fields: FormField[];
  onApply: (data: Record<string, string | boolean>) => void;
}) {
  const [state, setState] = useState<State>("idle");
  const [entries, setEntries] = useState<ExtractedEntry[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  async function fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    return btoa(
      new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), ""),
    );
  }

  async function handleImage(file: File) {
    setState("scanning");
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.5,
        maxWidthOrHeight: 1536,
        initialQuality: 0.7,
        fileType: "image/jpeg",
        useWebWorker: false,
      });
      const base64 = await fileToBase64(compressed);
      const result = await extractAnswersFromFilledForm(
        base64,
        "image/jpeg",
        fields,
      );
      handleResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed.");
      setState("error");
    }
  }

  async function handlePdf(file: File) {
    const MAX_PDF_BYTES = 7 * 1024 * 1024; // 7 MB — safe under 10 MB action limit after base64 overhead
    if (file.size > MAX_PDF_BYTES) {
      setError(
        `PDF is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 7 MB.`,
      );
      setState("error");
      return;
    }
    setState("scanning");
    try {
      const base64 = await fileToBase64(file);
      const result = await extractAnswersFromFilledForm(
        base64,
        "application/pdf",
        fields,
      );
      handleResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed.");
      setState("error");
    }
  }

  function handleResult(result: {
    success: boolean;
    mock?: boolean;
    answers?: Record<string, string>;
    error?: string;
  }) {
    if (!result.success || !result.answers) {
      setError(result.error ?? "No answers extracted.");
      setState("error");
      return;
    }

    const fieldMap = new Map(fields.map((f) => [f.id, f]));
    const extracted: ExtractedEntry[] = Object.entries(result.answers)
      .map(([id, value]) => {
        const field = fieldMap.get(id);
        return field ? { fieldId: id, label: field.label, value } : null;
      })
      .filter((e): e is ExtractedEntry => e !== null);

    if (extracted.length === 0) {
      setError("No answers matched this form's fields.");
      setState("error");
      return;
    }

    setIsMock(!!result.mock);
    setEntries(extracted);
    setState("review");
  }

  function handleApply() {
    const fieldMap = new Map(fields.map((f) => [f.id, f]));
    const data: Record<string, string | boolean> = {};
    for (const entry of entries) {
      const field = fieldMap.get(entry.fieldId);
      if (field?.type === "checkbox") {
        // Convert AI string output to boolean — never skip false
        data[entry.fieldId] = entry.value.trim().toLowerCase() === "true";
      } else if (entry.value.trim()) {
        data[entry.fieldId] = entry.value.trim();
      }
    }
    onApply(data);
    setState("idle");
    setEntries([]);
    toast.success(
      `${Object.keys(data).length} answer${Object.keys(data).length !== 1 ? "s" : ""} imported from paper`,
    );
  }

  function handleCancel() {
    setState("idle");
    setEntries([]);
    setError("");
  }

  // --- Idle: just a button ---
  if (state === "idle") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2 text-sm"
        onClick={() => setState("upload")}
      >
        <ScanLine className="size-4" />
        Import from Paper
      </Button>
    );
  }

  // --- Upload ---
  if (state === "upload") {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-zinc-700">
              Upload filled-out form to import answers
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleCancel}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              className="min-h-[48px] flex-1 gap-2"
              onClick={() => cameraRef.current?.click()}
            >
              <Camera className="size-4" />
              Camera
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-[48px] flex-1 gap-2"
              onClick={() => fileRef.current?.click()}
            >
              <FileUp className="size-4" />
              Photo
            </Button>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px] w-full gap-2"
            onClick={() => pdfRef.current?.click()}
          >
            <FileText className="size-4" />
            Upload PDF
          </Button>
          <input
            ref={cameraRef}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImage(f);
              e.target.value = "";
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImage(f);
              e.target.value = "";
            }}
          />
          <input
            ref={pdfRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handlePdf(f);
              e.target.value = "";
            }}
          />
        </CardContent>
      </Card>
    );
  }

  // --- Scanning ---
  if (state === "scanning") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-6">
          <div className="relative">
            <ScanLine className="size-10 animate-pulse text-zinc-400" />
            <Loader2 className="absolute -right-1 -bottom-1 size-5 animate-spin text-zinc-600" />
          </div>
          <p className="text-sm font-medium text-zinc-700">
            Reading filled form...
          </p>
          <p className="text-xs text-zinc-400">
            Extracting answers — about 20 seconds
          </p>
        </CardContent>
      </Card>
    );
  }

  // --- Error ---
  if (state === "error") {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-amber-600">
            <AlertTriangle className="size-4" />
            <p className="text-sm font-medium">Import failed</p>
          </div>
          <p className="text-xs text-zinc-500">{error}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={() => setState("upload")}
            >
              <RotateCcw className="size-3.5" />
              Try Again
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCancel}
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // --- Review ---
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-900">
              {entries.length} answer{entries.length !== 1 ? "s" : ""} extracted
            </p>
            <p className="text-xs text-zinc-500">
              Review and correct before importing
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
          >
            <X className="size-4" />
          </Button>
        </div>

        {isMock && (
          <div className="rounded border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
            Dev mode — sample data, not from your photo
          </div>
        )}

        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {entries.map((entry, i) => (
            <div key={entry.fieldId} className="space-y-0.5">
              <p className="truncate text-xs text-zinc-500">{entry.label}</p>
              <Input
                value={entry.value}
                onChange={(e) => {
                  const next = [...entries];
                  next[i] = { ...entry, value: e.target.value };
                  setEntries(next);
                }}
                className="h-9 text-sm"
              />
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-1">
          <Button type="button" className="flex-1" onClick={handleApply}>
            Apply {entries.length} answer{entries.length !== 1 ? "s" : ""}
          </Button>
          <Button type="button" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
