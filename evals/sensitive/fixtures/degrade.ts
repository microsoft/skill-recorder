// Calibrated degradation for the realistic OCR eval. Reproduces the production
// capture path instead of adding random noise: a fixture is authored as an SVG at
// a "native display" width, then downscaled to the ~1108px-wide JPEG that Electron
// actually stores for a captured frame (lanczos3 + lossy JPEG). Feeding THAT to the
// real `Ocr.recognize()` — which upscales + normalises internally — exercises the
// exact chain that silently failed in production (small on-screen text OCR'd to
// garbage → detectors match nothing → nothing blurred). Rendering clean, large text
// (as the older ocr-images eval does) never stresses this and passes while the
// feature is broken.
//
// Ground-truth boxes are authored in the SVG's hi-res coordinate space and mapped
// down to the captured-frame space with `scaleBox`, so they line up with the boxes
// `Ocr`/`sensitiveFrameBoxes` return (which are in captured-frame pixels).

import type { SharpModule } from "./templates";

/** Width of a stored capture frame in pixels — must match production
 *  (frames are ~1108px wide; see electron/sensitive/ocr.ts preprocessing note). */
export const CAPTURE_WIDTH = 1108;

/** JPEG quality Electron stores captured frames at (lossy — part of the degradation
 *  the eval must reproduce). Kept low enough to be realistic, not artificially clean. */
export const CAPTURE_JPEG_QUALITY = 75;

/** A ground-truth rectangle in some image's pixel space (half-open on x1/y1). */
export interface GtRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface DegradedFrame {
  /** The downscaled, JPEG-compressed capture (what production would store on disk). */
  jpeg: Buffer;
  /** Applied hi-res → capture scale factor (CAPTURE_WIDTH / hiResWidth). */
  scale: number;
  /** Capture-space dimensions (what the OCR + box mapper see). */
  width: number;
  height: number;
}

/** Render a hi-res SVG string, then downscale + JPEG-compress it exactly the way a
 *  real captured frame is degraded before it ever reaches OCR. */
export async function renderDegradedFrame(
  sharp: SharpModule,
  svg: string,
  hiResWidth: number,
): Promise<DegradedFrame> {
  const scale = CAPTURE_WIDTH / hiResWidth;
  const jpeg = await sharp(Buffer.from(svg))
    .resize({ width: CAPTURE_WIDTH, kernel: sharp.kernel.lanczos3 })
    .jpeg({ quality: CAPTURE_JPEG_QUALITY })
    .toBuffer();
  const meta = await sharp(jpeg).metadata();
  return { jpeg, scale, width: meta.width ?? CAPTURE_WIDTH, height: meta.height ?? 0 };
}

/** Map a ground-truth rect from hi-res template space into capture-frame space. */
export function scaleBox(rect: GtRect, scale: number): GtRect {
  return {
    x0: Math.round(rect.x0 * scale),
    y0: Math.round(rect.y0 * scale),
    x1: Math.round(rect.x1 * scale),
    y1: Math.round(rect.y1 * scale),
  };
}
