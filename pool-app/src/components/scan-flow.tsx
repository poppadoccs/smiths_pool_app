"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Camera,
  ImagePlus,
  FileUp,
  Loader2,
  RotateCcw,
  ScanLine,
  AlertTriangle,
} from "lucide-react";
import {
  extractFormTemplate,
  extractSinglePage,
  extractFormFromPdf,
  type ScanResult,
  type PageScanResult,
} from "@/lib/actions/scan";
import { TemplateEditor } from "@/components/template-editor";
import type { FormField } from "@/lib/forms";
import imageCompression from "browser-image-compression";

type ScanState =
  | "upload"
  | "scanning"
  | "scanning-multi"
  | "scanning-pdf"
  | "error"
  | "review";

type ScanProgress = {
  current: number;
  total: number;
  status: string;
};

export function ScanFlow({ mockMode = false }: { mockMode?: boolean }) {
  const [state, setState] = useState<ScanState>("upload");
  const [previews, setPreviews] = useState<string[]>([]);
  const [progress, setProgress] = useState<ScanProgress>({
    current: 0,
    total: 0,
    status: "",
  });
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [lastError, setLastError] = useState<string>("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  async function fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    return btoa(
      new Uint8Array(buffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ""
      )
    );
  }

  async function compressImage(file: File): Promise<File> {
    return imageCompression(file, {
      maxSizeMB: 2,
      maxWidthOrHeight: 2048,
      fileType: "image/jpeg",
      useWebWorker: false,
    });
  }

  function previewFromFile(file: File): Promise<string> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });
  }

  // --- Single image: fast path ---
  async function handleSingleImage(file: File) {
    setState("scanning");
    setProgress({ current: 1, total: 1, status: "Scanning form..." });

    const compressed = await compressImage(file);
    setPreviews([await previewFromFile(compressed)]);

    const base64 = await fileToBase64(compressed);
    const result = await extractFormTemplate(base64, "image/jpeg");
    handleResult(result);
  }

  // --- Multiple images: page-by-page ---
  async function handleMultipleImages(files: File[]) {
    setState("scanning-multi");
    const total = files.length;
    const allFields: FormField[] = [];
    const prevs: string[] = [];
    let templateName = "Scanned Form";

    for (let i = 0; i < total; i++) {
      setProgress({
        current: i + 1,
        total,
        status: `Scanning page ${i + 1} of ${total}...`,
      });

      const compressed = await compressImage(files[i]);
      prevs.push(await previewFromFile(compressed));
      setPreviews([...prevs]);

      const base64 = await fileToBase64(compressed);
      const result: PageScanResult = await extractSinglePage(
        base64,
        "image/jpeg"
      );

      if (result.error === "timeout") {
        setLastError(
          `Page ${i + 1} timed out. You can retry or skip this page.`
        );
        setState("error");
        return;
      }

      if (result.success && result.fields.length > 0) {
        allFields.push(...result.fields);
      }
    }

    // Renumber all fields in order
    const merged = allFields.map((f, idx) => ({ ...f, order: idx }));

    setProgress({
      current: total,
      total,
      status: "Building draft...",
    });

    if (merged.length === 0) {
      setLastError("No fields extracted from any page. Try clearer photos.");
      setState("error");
      return;
    }

    // Use first page's name if available, otherwise generic
    handleResult({
      success: true,
      template: {
        name: templateName,
        description: `Scanned from ${total} page${total > 1 ? "s" : ""}`,
        category: "",
        fields: merged,
      },
    });
  }

  // --- PDF upload ---
  async function handlePdf(file: File) {
    setState("scanning-pdf");
    setProgress({ current: 1, total: 1, status: "Scanning PDF..." });
    setPreviews([]);

    const base64 = await fileToBase64(file);
    const result = await extractFormFromPdf(base64);
    handleResult(result);
  }

  // --- Result handler ---
  function handleResult(result: ScanResult) {
    setScanResult(result);
    if (result.success) {
      setState("review");
      toast.success(
        `Found ${result.template?.fields.length} fields — review below`
      );
    } else {
      setLastError(result.error || "Extraction failed");
      setState("error");
    }
  }

  // --- Input handlers ---
  function handleCameraChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleSingleImage(file);
    e.target.value = "";
  }

  function handleLibraryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (files.length === 1) {
      handleSingleImage(files[0]);
    } else {
      handleMultipleImages(Array.from(files));
    }
    e.target.value = "";
  }

  function handlePdfChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handlePdf(file);
    e.target.value = "";
  }

  function handleRetry() {
    setState("upload");
    setPreviews([]);
    setScanResult(null);
    setLastError("");
  }

  // ====================
  // UPLOAD STATE
  // ====================
  if (state === "upload") {
    return (
      <div className="space-y-4">
        {mockMode && (
          <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 p-3 text-center">
            <p className="text-sm font-semibold text-amber-700">
              Dev Mode — returns sample data
            </p>
          </div>
        )}

        <Card>
          <CardContent className="p-4 space-y-3">
            <p className="text-base text-zinc-700 font-medium">
              Upload a blank paper form
            </p>
            <p className="text-sm text-zinc-500">
              One page? Take a photo. Multiple pages? Select all images or
              upload a PDF.
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
                Photos
              </Button>
            </div>

            <Button
              variant="outline"
              className="w-full min-h-[48px] text-base gap-2"
              onClick={() => pdfRef.current?.click()}
            >
              <FileUp className="size-5" />
              Upload PDF
            </Button>

            {/* Single photo (camera) */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              className="hidden"
              onChange={handleCameraChange}
            />
            {/* Multiple photos (library) */}
            <input
              ref={libraryRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={handleLibraryChange}
            />
            {/* PDF */}
            <input
              ref={pdfRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handlePdfChange}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ====================
  // SCANNING STATES
  // ====================
  if (
    state === "scanning" ||
    state === "scanning-multi" ||
    state === "scanning-pdf"
  ) {
    return (
      <div className="space-y-4">
        {/* Show latest preview thumbnail */}
        {previews.length > 0 && (
          <div className="rounded-lg overflow-hidden border border-zinc-200">
            <img
              src={previews[previews.length - 1]}
              alt="Scanning"
              className="w-full max-h-[200px] object-contain bg-zinc-50"
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
                {progress.status}
              </p>
              {progress.total > 1 && (
                <div className="mt-3 w-48 mx-auto">
                  <div className="h-2 rounded-full bg-zinc-200">
                    <div
                      className="h-2 rounded-full bg-zinc-900 transition-all duration-500"
                      style={{
                        width: `${(progress.current / progress.total) * 100}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    Page {progress.current} of {progress.total}
                  </p>
                </div>
              )}
              <p className="text-sm text-zinc-500 mt-2">
                {state === "scanning-pdf"
                  ? "Gemini is reading your PDF. This may take up to 60 seconds."
                  : "Extracting fields — about 10-20 seconds per page."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ====================
  // ERROR / TIMEOUT STATE
  // ====================
  if (state === "error") {
    return (
      <div className="space-y-4">
        {previews.length > 0 && (
          <div className="rounded-lg overflow-hidden border border-zinc-200">
            <img
              src={previews[previews.length - 1]}
              alt="Failed scan"
              className="w-full max-h-[200px] object-contain bg-zinc-50 opacity-60"
            />
          </div>
        )}

        <Card>
          <CardContent className="p-6 flex flex-col items-center gap-4">
            <AlertTriangle className="size-12 text-amber-500" />
            <div className="text-center">
              <p className="text-lg font-medium text-zinc-900">
                Scan didn&apos;t complete
              </p>
              <p className="text-sm text-zinc-500 mt-1">{lastError}</p>
            </div>

            <div className="flex flex-col gap-2 w-full">
              <Button
                className="w-full min-h-[48px] text-base gap-2"
                onClick={handleRetry}
              >
                <RotateCcw className="size-4" />
                Try Again
              </Button>
              <Button
                variant="outline"
                className="w-full min-h-[48px] text-base gap-2"
                onClick={() => pdfRef.current?.click()}
              >
                <FileUp className="size-4" />
                Upload as PDF Instead
              </Button>
              <Button
                variant="ghost"
                className="w-full min-h-[44px] text-sm text-zinc-500"
                onClick={() => libraryRef.current?.click()}
              >
                Or select different photos
              </Button>
            </div>

            {/* Keep file inputs available for retry options */}
            <input
              ref={pdfRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handlePdfChange}
            />
            <input
              ref={libraryRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={handleLibraryChange}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ====================
  // REVIEW STATE
  // ====================
  if (state === "review" && scanResult?.template) {
    const { template } = scanResult;
    return (
      <div className="space-y-4">
        {previews.length > 0 && (
          <div className="flex gap-2 overflow-x-auto py-1">
            {previews.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`Page ${i + 1}`}
                className="h-24 rounded border border-zinc-200 object-contain bg-zinc-50 shrink-0"
              />
            ))}
          </div>
        )}

        {scanResult.mock && (
          <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 p-3 text-center">
            <p className="text-sm font-semibold text-amber-700">
              Dev Mode — sample data, not from your photo
            </p>
          </div>
        )}

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-base font-medium text-zinc-900">
                  Extracted {template.fields.length} fields
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
