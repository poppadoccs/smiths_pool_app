import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPdfImageBytes, MAX_PDF_DATA_IMAGE_BYTES } from "@/lib/pdf-image";

const blobUrl =
  "https://test-store.public.blob.vercel-storage.com/photos/pool.png";
const imageBytes = Uint8Array.from([1, 2, 3]);

function imageResponse(overrides: Partial<Response> = {}): Response {
  return {
    ok: true,
    redirected: false,
    arrayBuffer: vi.fn(async () => imageBytes.buffer),
    ...overrides,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => imageResponse()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PDF image fetch boundary", () => {
  it("reads a public Blob URL without credentials or following redirects", async () => {
    expect(await fetchPdfImageBytes(blobUrl)).toEqual(imageBytes);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(blobUrl, {
      redirect: "error",
      credentials: "omit",
    });
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/private.png",
    "file:///etc/passwd",
    "//test-store.public.blob.vercel-storage.com/pool.png",
    "http://test-store.public.blob.vercel-storage.com/pool.png",
    "https://public.blob.vercel-storage.com/pool.png",
    "https://test-store.public.blob.vercel-storage.com.attacker.invalid/pool.png",
    "https://test-storepublic.blob.vercel-storage.com/pool.png",
    "https://nested.test-store.public.blob.vercel-storage.com/pool.png",
    "https://test-store.private.blob.vercel-storage.com/pool.png",
    "https://test-store.public.blob.vercel-storage.com@127.0.0.1/pool.png",
    "https://user:password@test-store.public.blob.vercel-storage.com/pool.png",
    "https://test-store.public.blob.vercel-storage.com:443/pool.png",
    "https://test-store.public.blob.vercel-storage.com:8443/pool.png",
    "https://test-store.public.blob.vercel-storage.com\\@127.0.0.1/pool.png",
    "https://test-store.public.blob.vercel-storage.com/pool\n.png",
  ])("rejects an unsupported URL before any request: %s", async (url) => {
    await expect(fetchPdfImageBytes(url)).rejects.toThrow(
      "Unsupported PDF image URL",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not consume a redirect response or request its destination", async () => {
    const response = imageResponse({ ok: false, status: 302 });
    vi.mocked(fetch).mockResolvedValueOnce(response);
    await expect(fetchPdfImageBytes(blobUrl)).rejects.toThrow(
      "PDF image could not be loaded",
    );
    expect(response.arrayBuffer).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(blobUrl, {
      redirect: "error",
      credentials: "omit",
    });
  });

  it("rejects a response that was already redirected", async () => {
    const response = imageResponse({ redirected: true });
    vi.mocked(fetch).mockResolvedValueOnce(response);
    await expect(fetchPdfImageBytes(blobUrl)).rejects.toThrow(
      "PDF image could not be loaded",
    );
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it("propagates the fetch redirect error without retrying", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      new TypeError("redirect disallowed"),
    );
    await expect(fetchPdfImageBytes(blobUrl)).rejects.toThrow(
      "redirect disallowed",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["png", "jpeg", "webp", "gif"])(
    "decodes a bounded image/%s data URL locally",
    async (format) => {
      const encoded = Buffer.from(imageBytes).toString("base64");
      expect([
        ...(await fetchPdfImageBytes(`data:image/${format};base64,${encoded}`)),
      ]).toEqual([...imageBytes]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/png;charset=utf-8;base64,AQID",
    "data:image/png,%89PNG",
    "data:image/png;base64,",
    "data:image/png;base64,AQ%2bD",
    "data:image/png;base64,AQID\n",
    "data:image/png;base64,AB==",
  ])("rejects malformed or unsupported data images: %s", async (url) => {
    await expect(fetchPdfImageBytes(url)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized encoded data before decoding", async () => {
    const encoded = "A".repeat(Math.ceil(MAX_PDF_DATA_IMAGE_BYTES / 3) * 4 + 4);
    await expect(
      fetchPdfImageBytes(`data:image/png;base64,${encoded}`),
    ).rejects.toThrow("PDF data image is too large");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the decoded size at the base64 padding boundary", async () => {
    const encoded = Buffer.alloc(MAX_PDF_DATA_IMAGE_BYTES + 1).toString(
      "base64",
    );
    await expect(
      fetchPdfImageBytes(`data:image/png;base64,${encoded}`),
    ).rejects.toThrow("PDF data image is too large");
    expect(fetch).not.toHaveBeenCalled();
  });
});
