"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Camera, ImagePlus, Loader2, RotateCcw, ScanLine } from "lucide-react";
import { extractFormTemplate, type ScanResult } from "@/lib/actions/scan";
import { TemplateEditor } from "@/components/template-editor";
import imageCompression from "browser-image-compression";

type ScanState = "upload" | "processing" | "review";

export function ScanFlow({ mockMode = false }: { mockMode?: boolean }) {
  const [state, setState] = useState<ScanState>("upload");
  const [preview, setPreview] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    // Compress before sending to AI (save bandwidth + API costs)
    const compressed = await imageCompression(file, {
      maxSizeMB: 2,
      maxWidthOrHeight: 2048,
      fileType: "image/jpeg",
      useWebWorker: false,
    });

    // Create preview
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(compressed);

    // Convert to base64 for the server action
    const buffer = await compressed.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(buffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ""
      )
    );

    setState("processing");

    const result = await extractFormTemplate(base64, "image/jpeg");
    setScanResult(result);

    if (result.success) {
      setState("review");
      toast.success(
        `Found ${result.template?.fields.length} fields — review below`
      );
    } else {
      setState("upload");
      toast.error(result.error || "Extraction failed");
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  }

  function handleRetry() {
    setState("upload");
    setPreview(null);
    setScanResult(null);
  }

  // --- UPLOAD STATE ---
  if (state === "upload") {
    return (
      <div className="space-y-4">
        {mockMode && (
          <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 p-3 text-center">
            <p className="text-sm font-semibold text-amber-700">
              Mock Scan Mode
            </p>
            <p className="text-xs text-amber-600">
              No AI key configured — returns sample data for testing.
              Upload any image to try the flow.
            </p>
          </div>
        )}

        {preview && (
          <div className="rounded-lg overflow-hidden border border-zinc-200">
            <img
              src={preview}
              alt="Form preview"
              className="w-full max-h-[300px] object-contain bg-zinc-50"
            />
          </div>
        )}

        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-base text-zinc-700 font-medium">
              {mockMode
                ? "Upload any image to test the scan flow"
                : "Upload a clear photo of a blank paper form"}
            </p>
            <p className="text-sm text-zinc-500">
              {mockMode
                ? "A realistic sample template will be returned for review."
                : "Make sure all fields are visible. The AI will extract labels, types, and structure."}
            </p>

            <div className="flex gap-3">
              <Button
                className="flex-1 min-h-[52px] text-base gap-2"
                onClick={() => cameraRef.current?.click()}
              >
                <Camera className="size-5" />
                Take Photo
              </Button>
              <Button
                variant="outline"
                className="flex-1 min-h-[52px] text-base gap-2"
                onClick={() => libraryRef.current?.click()}
              >
                <ImagePlus className="size-5" />
                From Library
              </Button>
            </div>

            <input
              ref={cameraRef}
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              className="hidden"
              onChange={handleInputChange}
            />
            <input
              ref={libraryRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleInputChange}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // --- PROCESSING STATE ---
  if (state === "processing") {
    return (
      <div className="space-y-4">
        {preview && (
          <div className="rounded-lg overflow-hidden border border-zinc-200">
            <img
              src={preview}
              alt="Form being scanned"
              className="w-full max-h-[300px] object-contain bg-zinc-50"
            />
          </div>
        )}

        <Card>
          <CardContent className="p-6 flex flex-col items-center gap-4">
            <div className="relative">
              <ScanLine className="size-12 text-zinc-400 animate-pulse" />
              <Loader2 className="size-6 text-zinc-600 animate-spin absolute -bottom-1 -right-1" />
            </div>
            <div className="text-center">
              <p className="text-lg font-medium text-zinc-900">
                {mockMode ? "Loading mock template..." : "Scanning form..."}
              </p>
              <p className="text-sm text-zinc-500 mt-1">
                {mockMode
                  ? "Generating sample data for testing."
                  : "The AI is reading your form and extracting fields. This takes 10-20 seconds."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // --- REVIEW STATE ---
  if (state === "review" && scanResult?.template) {
    const { template } = scanResult;
    return (
      <div className="space-y-4">
        {preview && (
          <div className="rounded-lg overflow-hidden border border-zinc-200">
            <img
              src={preview}
              alt="Scanned form"
              className="w-full max-h-[200px] object-contain bg-zinc-50"
            />
          </div>
        )}

        {scanResult.mock && (
          <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 p-3 text-center">
            <p className="text-sm font-semibold text-amber-700">
              Mock Scan Mode — This is sample data, not from your photo
            </p>
          </div>
        )}

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-base font-medium text-zinc-900">
                  {scanResult.mock ? "Sample" : "AI"} extracted {template.fields.length} fields
                </p>
                <p className="text-sm text-zinc-500">
                  Review and fix anything that looks wrong before saving.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={handleRetry}
              >
                <RotateCcw className="size-4" />
                Rescan
              </Button>
            </div>
          </CardContent>
        </Card>

        <Separator />

        <TemplateEditor
          mode="create"
          initialName={template.name}
          initialDescription={template.description}
          initialCategory={template.category}
          initialFields={template.fields}
        />
      </div>
    );
  }

  return null;
}
