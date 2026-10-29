/** Chat photos are compressed before upload, like WhatsApp/Telegram: long side <= 1600 px, JPEG 0.8. */
export const MAX_IMAGE_SIDE = 1600;
const JPEG_QUALITY = 0.8;

/** Size after scaling the long side down to `max`; never upscales. */
export function fitSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Images that get re-encoded: every image type except GIF (animation). */
export function isCompressible(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/gif";
}

/** The re-encoded file name: same base, .jpg or .png. */
export function compressedName(name: string, mime: "image/jpeg" | "image/png"): string {
  const base = name.replace(/\.[^./\\]+$/, "") || "image";
  return `${base}.${mime === "image/png" ? "png" : "jpg"}`;
}

function hasTransparency(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): boolean {
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
  return false;
}

/** Returns the compressed copy of an image file, or the file itself when it is not an image, is a GIF, or cannot be decoded. */
export async function compressImage(file: File): Promise<File> {
  if (!isCompressible(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const mime = file.type !== "image/jpeg" && hasTransparency(ctx, width, height) ? "image/png" : "image/jpeg";
    const blob = await canvas.convertToBlob(mime === "image/jpeg" ? { type: mime, quality: JPEG_QUALITY } : { type: mime });
    return new File([blob], compressedName(file.name, mime), { type: mime });
  } catch {
    return file;
  }
}
