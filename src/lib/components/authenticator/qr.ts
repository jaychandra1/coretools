/**
 * Client-side QR decode (jsQR) and encode (qrcode). No network involved:
 * camera frames and uploaded images are processed in-page on a canvas, and
 * generated QR codes are data: URLs.
 */

import jsQR from "jsqr";
import QRCode from "qrcode";

function decodeImageData(imageData: ImageData): string | null {
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
  return result?.data ?? null;
}

/** Decode a QR code from an uploaded/pasted image file. */
export async function decodeQrFromImage(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return decodeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  } finally {
    bitmap.close();
  }
}

/** Decode the current frame of a playing <video>. Reuses `canvas`. */
export function decodeQrFromVideo(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): string | null {
  if (video.readyState < video.HAVE_CURRENT_DATA) return null;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return decodeImageData(ctx.getImageData(0, 0, width, height));
}

/** Render text as a QR code data: URL (PNG). */
export function qrDataUrl(text: string, size = 240): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}
