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
  X,
  Plus,
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
  | "queue"
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

type QueuedImage = {
  file: File;
  preview: string;
};

export function ScanFlow({ mockMode = false }: { mockMode?: boolean }) {
  const [state, setState] = useState<ScanState>("upload");
  const [previews, setPreviews] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueuedImage[]>([]);
  const [progress, setProgress] = useState<ScanProgress>({
    current: 0,
    total: 0,
    status: "",
  });
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [lastError, setLastError] = useState<string>("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const addPageRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  // --- Utilities ---

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
      maxSizeMB: 0.5,
      maxWidthOrHeight: 1536,
      initialQuality: 0.7,
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

  function withClientTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
          ms
        )
      ),
    ]);
  }

  // --- Single image: fast path ---
  async function handleSingleImage(file: File) {
    setState("scanning");
    setProgress({ current: 1, total: 1, status: "Compressing..." });

    const t0 = Date.now();
    console.log("[scan] image selected:", file.name, `${(file.size / 1024 / 1024).toFixed(1)}MB`);

    const compressed = await compressImage(file);
    console.log("[scan] compressed:", `${(compressed.size / 1024).toFixed(0)}KB`, `${Date.now() - t0}ms`);

    setPreviews([await previewFromFile(compressed)]);
    setProgress({ current: 1, total: 1, status: "Scanning form..." });

    const base64 = await fileToBase64(compressed);
    console.log("[scan] base64 ready:", `${(base64.length / 1024).toFixed(0)}KB`, `${Date.now() - t0}ms`);

    try {
      const result = await withClientTimeout(
        extractFormTemplate(base64, "image/jpeg"),
        35_000,
        "Single-page scan"
      );
      console.log("[scan] result:", result.success, `${Date.now() - t0}ms`);
      handleResult(result);
    } catch (err) {
      console.log("[scan] client timeout hit:", `${Date.now() - t0}ms`);
      setLastError(
        err instanceof Error ? err.message : "Scan timed out. Try a clearer or smaller photo."
      );
      setState("error");
    }
  }

  // --- Multi-page: process queued images ---
  async function handleScanQueue(images: QueuedImage[]) {
    setState("scanning-multi");
    const total = images.length;
    const allFields: FormField[] = [];
    const prevs: string[] = [];
    const t0 = Date.now();

    for (let i = 0; i < total; i++) {
      setProgress({
        current: i + 1,
        total,
        status: `Compressing page ${i + 1}...`,
      });

      const compressed = await compressImage(images[i].file);
      prevs.push(await previewFromFile(compressed));
      setPreviews([...prevs]);

      setProgress({
        current: i + 1,
        total,
        status: `Scanning page ${i + 1} of ${total}...`,
      });

      const base64 = await fileToBase64(compressed);
      console.log(`[scan] page ${i + 1}/${total} compressed:`, `${(compressed.size / 1024).toFixed(0)}KB`, `${Date.now() - t0}ms`);

      try {
        const result: PageScanResult = await withClientTimeout(
          extractSinglePage(base64, "image/jpeg"),
          35_000,
          `Page ${i + 1}`
        );

        if (result.error === "timeout") {
          setLastError(`Page ${i + 1} timed out. You can retry or skip this page.`);
          setState("error");
          return;
        }

        if (result.success && result.fields.length > 0) {
          allFields.push(...result.fields);
        }
        console.log(`[scan] page ${i + 1} done:`, result.fields.length, "fields", `${Date.now() - t0}ms`);
      } catch (err) {
        setLastError(`Page ${i + 1} timed out after 35 seconds.`);
        setState("error");
        return;
      }
    }

    setProgress({ current: total, total, status: "Building draft..." });

    const merged = allFields.map((f, idx) => ({ ...f, order: idx }));

    if (merged.length === 0) {
      setLastError("No fields extracted from any page. Try clearer photos.");
      setState("error");
      return;
    }

    handleResult({
      success: true,
      template: {
        name: "Scanned Form",
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

    const t0 = Date.now();
    console.log("[scan] PDF selected:", file.name, `${(file.size / 1024 / 1024).toFixed(1)}MB`);

    const base64 = await fileToBase64(file);

    try {
      const result = await withClientTimeout(
        extractFormFromPdf(base64),
        65_000,
        "PDF scan"
      );
      console.log("[scan] PDF result:", result.success, `${Date.now() - t0}ms`);
      handleResult(result);
    } catch (err) {
      console.log("[scan] PDF client timeout:", `${Date.now() - t0}ms`);
      setLastError(
        "PDF scan timed out. Try uploading individual page photos instead."
      );
      setState("error");
    }
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

  async function handleAddToQueue(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newItems: QueuedImage[] = [];
    for (let i = 0; i < files.length; i++) {
      const preview = await previewFromFile(files[i]);
      newItems.push({ file: files[i], preview });
    }
    setQueue((prev) => [...prev, ...newItems]);
    if (state === "upload") setState("queue");
    e.target.value = "";
  }

  function removeFromQueue(index: number) {
    setQueue((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) setState("upload");
      return next;
    });
  }

  function handlePdfChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handlePdf(file);
    e.target.value = "";
  }

  function handleRetry() {
    setState("upload");
    setPreviews([]);
    setQueue([]);
    setScanResult(null);
    setLastError("");
  }

  // ====================
  // UPLOAD STATE
  // ====================
  if (state === "upload" || state === "queue") {
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
              One page? Take a photo. Multi-page? Add each page below, then scan all at once.
            </p>

            {/* Photo queue */}
            {queue.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-zinc-700">
                  {queue.length} page{queue.length !== 1 ? "s" : ""} ready to scan
                </p>
                <div className="flex gap-2 overflow-x-auto py-1">
                  {queue.map((item, i) => (
                    <div key={i} className="relative shrink-0">
                      <img
                        src={item.preview}
                        alt={`Page ${i + 1}`}
                        className="h-20 w-16 rounded border border-zinc-200 object-cover"
                      />
                      <button
                        type="button"
                        className="absolute -top-1.5 -right-1.5 rounded-full bg-red-500 p-0.5 text-white"
                        onClick={() => removeFromQueue(i)}
                      >
                        <X className="size-3" />
                      </button>
                      <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-center text-[10px] text-white rounded-b">
                        {i + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3">
              {queue.length === 0 ? (
                <>
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
                    onClick={() => addPageRef.current?.click()}
                  >
                    <ImagePlus className="size-5" />
                    Add Pages
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="flex-1 min-h-[52px] text-base gap-2"
                    onClick={() => addPageRef.current?.click()}
                  >
                    <Plus className="size-5" />
                    Add More
                  </Button>
                  <Button
                    className="flex-1 min-h-[52px] text-base gap-2"
                    onClick={() => handleScanQueue(queue)}
                  >
                    <ScanLine className="size-5" />
                    Scan {queue.length} Page{queue.length !== 1 ? "s" : ""}
                  </Button>
                </>
              )}
            </div>

            {queue.length === 0 && (
              <Button
                variant="outline"
                className="w-full min-h-[48px] text-base gap-2"
                onClick={() => pdfRef.current?.click()}
              >
                <FileUp className="size-5" />
                Upload PDF
              </Button>
            )}

            {/* Camera input (single) */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              className="hidden"
              onChange={handleCameraChange}
            />
            {/* Library input (multi-select or single, adds to queue) */}
            <input
              ref={addPageRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={handleAddToQueue}
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
                  ? "Reading PDF — up to 60 seconds."
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
            </div>

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
