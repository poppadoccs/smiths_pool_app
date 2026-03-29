import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const filename = formData.get("filename") as string | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    console.log(
      `[upload-route] Uploading ${filename || file.name} (${(file.size / 1024).toFixed(0)}KB, ${file.type})`
    );

    const blob = await put(filename || file.name, file, {
      access: "public",
      addRandomSuffix: true,
      contentType: file.type || "image/jpeg",
    });

    console.log(`[upload-route] Uploaded: ${blob.url}`);

    return NextResponse.json({ url: blob.url, size: file.size });
  } catch (error) {
    console.error("[upload-route] Error:", (error as Error).message);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
