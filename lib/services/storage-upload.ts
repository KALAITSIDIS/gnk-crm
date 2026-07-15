import "server-only";

/**
 * Wrap binary data for a Supabase Storage upload.
 *
 * WHY THIS EXISTS: `@supabase/storage-js` sends a raw Node `Buffer` /
 * `Uint8Array` as a *direct* fetch body. On Vercel's serverless runtime that
 * body gets UTF-8-stringified before it hits the network — every byte ≥ 0x80
 * becomes the replacement sequence 0xEF 0xBF 0xBD, so the stored file is
 * corrupt (an image's RIFF/WEBP header survives but the pixel data is
 * destroyed, and the file even grows). Node 18–24 locally happen to send the
 * Buffer as-is, which is why it never reproduces in dev.
 *
 * A `Blob` takes a different path inside storage-js: it is wrapped in
 * `FormData` and sent as multipart/form-data, which is binary-safe on every
 * runtime. Always upload via this helper (or pass a File/Blob directly).
 */
export function binaryBody(
  data: Buffer | Uint8Array | ArrayBuffer,
  contentType: string,
): Blob {
  // Normalise to a plain ArrayBuffer-backed Uint8Array (a valid BlobPart;
  // Node Buffer's ArrayBufferLike union isn't assignable directly).
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  return new Blob([bytes], { type: contentType });
}
