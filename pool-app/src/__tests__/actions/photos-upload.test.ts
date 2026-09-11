// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { job: { findUnique: vi.fn() }, $executeRaw: vi.fn() },
}));
vi.mock("@vercel/blob", () => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { db } from "@/lib/db";
import { del, put } from "@vercel/blob";
import { POST } from "@/app/api/photos/upload/route";
import * as photoActions from "@/lib/actions/photos";

const uploadedUrl =
  "https://fixture.public.blob.vercel-storage.com/new-photo.jpg";
const foreignUrl =
  "https://fixture.public.blob.vercel-storage.com/submitted-photo.jpg";

function payload() {
  const data = new FormData();
  data.set("jobId", "draft-job");
  data.set("originalFilename", "Pool view (1).HEIC");
  data.set(
    "file",
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "compressed.jpg", {
      type: "image/jpeg",
    }),
  );
  return data;
}

function request(data = payload()) {
  return new Request("http://localhost/api/photos/upload", {
    method: "POST",
    body: data,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.job.findUnique).mockResolvedValue({ status: "DRAFT" } as never);
  vi.mocked(db.$executeRaw).mockResolvedValue(1);
  vi.mocked(put).mockResolvedValue({ url: uploadedUrl } as never);
  vi.mocked(del).mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("photo upload and server-owned registration", () => {
  it("registers only the uploaded Blob URL and received file size, ignoring forged metadata", async () => {
    const data = payload();
    data.set("url", foreignUrl);
    data.set("size", "999999");
    data.set("uploadedAt", "2000-01-01");
    data.set("filename", "forged-storage-path");

    const response = await POST(request(data));
    const metadata = await response.json();
    expect(response.status).toBe(200);
    expect(metadata).toEqual({
      url: uploadedUrl,
      filename: "Pool view (1).HEIC",
      size: 4,
      uploadedAt: expect.any(String),
    });
    expect(metadata.uploadedAt).not.toBe("2000-01-01");
    expect(put).toHaveBeenCalledWith("Pool_view__1_.HEIC", expect.any(File), {
      access: "public",
      addRandomSuffix: true,
      contentType: "image/jpeg",
    });
    const [sql, photoJson, jobId] = vi.mocked(db.$executeRaw).mock.calls[0];
    expect((sql as TemplateStringsArray).join("?")).toContain(
      "AND status::text = 'DRAFT'",
    );
    expect(JSON.parse(photoJson as string)).toEqual([metadata]);
    expect(jobId).toBe("draft-job");
    expect(JSON.stringify(vi.mocked(db.$executeRaw).mock.calls)).not.toContain(
      foreignUrl,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it("has no public action that registers a supplied photo URL", async () => {
    expect(photoActions).not.toHaveProperty("savePhotoMetadata");
    const data = payload();
    data.delete("file");
    data.set("url", foreignUrl);
    expect((await POST(request(data))).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([
    ["missing job", (data: FormData) => data.delete("jobId")],
    ["blank job", (data: FormData) => data.set("jobId", " ")],
    [
      "missing display filename",
      (data: FormData) => data.delete("originalFilename"),
    ],
    [
      "blank display filename",
      (data: FormData) => data.set("originalFilename", " "),
    ],
    [
      "oversized display filename",
      (data: FormData) => data.set("originalFilename", "a".repeat(256)),
    ],
    ["text instead of file", (data: FormData) => data.set("file", foreignUrl)],
    [
      "empty file",
      (data: FormData) =>
        data.set("file", new File([], "empty.jpg", { type: "image/jpeg" })),
    ],
    [
      "non-photo file",
      (data: FormData) =>
        data.set(
          "file",
          new File(["text"], "note.txt", { type: "text/plain" }),
        ),
    ],
  ])(
    "rejects %s before any Blob or database mutation",
    async (_name, change) => {
      const data = payload();
      change(data);
      expect((await POST(request(data))).status).toBe(400);
      expect(db.job.findUnique).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed multipart and oversized files", async () => {
    const malformed = new Request("http://localhost/api/photos/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await POST(malformed)).status).toBe(400);
    const data = payload();
    data.set(
      "file",
      new File([new Uint8Array(4 * 1024 * 1024 + 1)], "large.jpg", {
        type: "image/jpeg",
      }),
    );
    expect((await POST(request(data))).status).toBe(413);
    expect(put).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it.each(["SUBMITTED", "ARCHIVED"])(
    "rejects a %s job before uploading",
    async (status) => {
      vi.mocked(db.job.findUnique).mockResolvedValue({ status } as never);
      expect((await POST(request())).status).toBe(409);
      expect(put).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing job before uploading", async () => {
    vi.mocked(db.job.findUnique).mockResolvedValue(null);
    expect((await POST(request())).status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not attach a photo when the job is submitted while put is in flight", async () => {
    vi.mocked(put).mockImplementation(async () => {
      // Models the DRAFT predicate finding the job submitted at UPDATE time.
      vi.mocked(db.$executeRaw).mockResolvedValue(0);
      return { url: uploadedUrl } as never;
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("url");
    expect(del).toHaveBeenCalledExactlyOnceWith(uploadedUrl);
    expect(del).not.toHaveBeenCalledWith(foreignUrl);
  });

  it("keeps the definitive rejection even if cleaning its unused Blob fails", async () => {
    vi.mocked(db.$executeRaw).mockResolvedValue(0);
    vi.mocked(del).mockRejectedValue(new Error("cleanup failed"));
    expect((await POST(request())).status).toBe(409);
  });

  it("does not write metadata when Blob upload fails", async () => {
    vi.mocked(put).mockRejectedValue(new Error("provider failure"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("url");
  });

  it("never deletes a Blob after an ambiguous database append error", async () => {
    vi.mocked(db.$executeRaw).mockRejectedValue(
      new Error("connection lost after possible commit"),
    );
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(put).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("url");
  });

  it("does not upload when the initial job lookup fails", async () => {
    vi.mocked(db.job.findUnique).mockRejectedValue(
      new Error("database unavailable"),
    );
    expect((await POST(request())).status).toBe(500);
    expect(put).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
