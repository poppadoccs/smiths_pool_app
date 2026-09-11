const PUBLIC_BLOB_HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.public\.blob\.vercel-storage\.com$/i;
const RASTER_DATA_HEADER = /^data:image\/(?:png|jpeg|webp|gif);base64,/i;
export const MAX_PDF_DATA_IMAGE_BYTES = 5 * 1024 * 1024;

/** Read report images without allowing stored form values to select arbitrary hosts. */
export async function fetchPdfImageBytes(source: string): Promise<Uint8Array> {
  if (typeof source !== "string") throw new Error("Unsupported PDF image URL");

  const dataHeader = source.match(RASTER_DATA_HEADER)?.[0];
  if (dataHeader) {
    // Bound the encoded input before allocating its decoded buffer.
    const maxEncodedLength = Math.ceil(MAX_PDF_DATA_IMAGE_BYTES / 3) * 4;
    if (source.length - dataHeader.length > maxEncodedLength) {
      throw new Error("PDF data image is too large");
    }
    const encoded = source.slice(dataHeader.length);
    if (
      encoded.length === 0 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    ) {
      throw new Error("Invalid PDF data image");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength > MAX_PDF_DATA_IMAGE_BYTES) {
      throw new Error("PDF data image is too large");
    }
    if (bytes.toString("base64") !== encoded) {
      throw new Error("Invalid PDF data image");
    }
    return bytes;
  }

  // Check the raw authority too: URL normalizes an explicit :443 away.
  // Backslashes and control characters can also change URL parsing.
  const authority = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(source)?.[1];
  if (
    !authority ||
    !PUBLIC_BLOB_HOST.test(authority) ||
    /[\u0000-\u0020\u007f\\]/.test(source)
  ) {
    throw new Error("Unsupported PDF image URL");
  }
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !PUBLIC_BLOB_HOST.test(url.hostname)
  ) {
    throw new Error("Unsupported PDF image URL");
  }

  const response = await fetch(source, {
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok || response.redirected) {
    throw new Error("PDF image could not be loaded");
  }
  return new Uint8Array(await response.arrayBuffer());
}
