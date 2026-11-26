import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist";

const scale = 1.5;
const minimumClearancePoints = 5;
// Against white paper, 4.5:1 contrast requires relative luminance <= 0.1833.
const maximumReadableLuminance = (1.05 / 4.5) - 0.05;
const linearChannel = Array.from({ length: 256 }, (_, value) => {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
});

export interface PageImageInspection {
  width: number;
  height: number;
  inkPixels: number;
  readableInkPixels: number;
  inkRows: number;
  clearances: { left: number; right: number; top: number; bottom: number };
}

export interface TextImageRegion { x: number; y: number; width: number; height: number }

/** A rendered résumé that needs a person to inspect it before any employer upload. */
export class ResumeVisualReviewRequiredError extends Error {
  constructor(message: string, readonly artifactPath?: string) { super(message); }
}

function luminance(pixels: Uint8ClampedArray, offset: number): number {
  return linearChannel[pixels[offset]!]! * 0.2126
    + linearChannel[pixels[offset + 1]!]! * 0.7152
    + linearChannel[pixels[offset + 2]!]! * 0.0722;
}

/** Render a PDF page and reject blank, clipped, or visually uncertain output. */
export async function inspectPdfPageImage(
  page: PDFPageProxy, textRegions: readonly TextImageRegion[] = [],
): Promise<PageImageInspection> {
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width < 1 || height < 1 || width * height > 2_000_000) {
    throw new ResumeVisualReviewRequiredError("Résumé page image exceeds the visual inspection budget");
  }
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  // PDF.js declares DOM canvas types; its Node renderer accepts this native canvas.
  const render = page.render({ canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D, viewport });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([render.promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        render.cancel();
        reject(new Error("Résumé page image rendering timed out"));
      }, 10_000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
  const pixels = context.getImageData(0, 0, width, height).data;
  let inkPixels = 0;
  let readableInkPixels = 0;
  let inkRows = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    let rowHasInk = false;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (pixels[offset]! > 245 && pixels[offset + 1]! > 245 && pixels[offset + 2]! > 245) continue;
      inkPixels += 1;
      if (luminance(pixels, offset) <= maximumReadableLuminance) readableInkPixels += 1;
      rowHasInk = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (rowHasInk) inkRows += 1;
  }
  if (inkPixels < 100 || inkPixels > width * height * 0.5) {
    throw new ResumeVisualReviewRequiredError("Résumé page image is blank or has excessive ink");
  }
  if (readableInkPixels < 100) {
    throw new ResumeVisualReviewRequiredError("Résumé page image has insufficient high-contrast ink");
  }
  const clearances = {
    left: minX / scale,
    right: (width - 1 - maxX) / scale,
    top: minY / scale,
    bottom: (height - 1 - maxY) / scale,
  };
  if (Object.values(clearances).some((distance) => distance < minimumClearancePoints)) {
    throw new ResumeVisualReviewRequiredError("Résumé page image has ink too close to the page edge");
  }
  // A dark heading can hide a pale body line in a whole-page count. Check each
  // extractable text item against the actual page raster. This is a conservative
  // contrast sanity check, not proof that text reads well or is well laid out.
  for (const region of textRegions) {
    if (!Number.isFinite(region.x + region.y + region.width + region.height)
      || region.width <= 0 || region.height <= 0) {
      throw new ResumeVisualReviewRequiredError("Résumé text region needs human visual review");
    }
    const left = Math.max(0, Math.floor((region.x - 1) * scale));
    const right = Math.min(width, Math.ceil((region.x + region.width + 1) * scale));
    const nearestLineAbove = Math.min(...textRegions
      .filter((other) => other.y > region.y + 0.5 && other.x < region.x + region.width
        && region.x < other.x + other.width)
      .map((other) => other.y - region.y), Infinity);
    const regionHeight = Math.min(region.height, nearestLineAbove * 0.75);
    const top = Math.max(0, Math.floor((viewport.height / scale - region.y - regionHeight - 1) * scale));
    const bottom = Math.min(height, Math.ceil((viewport.height / scale - region.y + 1) * scale));
    let readable = 0;
    let readableRows = 0;
    for (let y = top; y < bottom; y += 1) {
      let rowReadable = 0;
      let run = 0;
      let longestRun = 0;
      for (let x = left; x < right; x += 1) {
        if (luminance(pixels, (y * width + x) * 4) <= maximumReadableLuminance) {
          rowReadable += 1;
          run += 1;
          longestRun = Math.max(longestRun, run);
        } else run = 0;
      }
      // A rule crossing a pale line of text is not evidence of readable glyphs.
      if (longestRun >= Math.max(8, (right - left) * 0.45)) continue;
      readable += rowReadable;
      if (rowReadable > 0) readableRows += 1;
    }
    // Two isolated dark pixels (for example a nearby rule) do not establish
    // that the text itself rendered. Use a small area floor; uncertain output
    // goes to review rather than to an employer upload.
    const minimumReadable = Math.max(4, Math.ceil((right - left) * (bottom - top) * 0.03));
    if (readable < minimumReadable || readableRows < 4) {
      throw new ResumeVisualReviewRequiredError("Résumé text region has insufficient contrast; human visual review required");
    }
  }
  return { width, height, inkPixels, readableInkPixels, inkRows, clearances };
}
