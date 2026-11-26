import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist";

const scale = 1.5;
const minimumClearancePoints = 5;

export interface PageImageInspection {
  width: number;
  height: number;
  inkPixels: number;
  inkRows: number;
  clearances: { left: number; right: number; top: number; bottom: number };
}

/** Render a PDF page and reject blank, clipped, or visually uncertain output. */
export async function inspectPdfPageImage(page: PDFPageProxy): Promise<PageImageInspection> {
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width < 1 || height < 1 || width * height > 2_000_000) {
    throw new Error("Résumé page image exceeds the visual inspection budget");
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
      rowHasInk = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (rowHasInk) inkRows += 1;
  }
  if (inkPixels < 100 || inkPixels > width * height * 0.5) {
    throw new Error("Résumé page image is blank or has excessive ink");
  }
  const clearances = {
    left: minX / scale,
    right: (width - 1 - maxX) / scale,
    top: minY / scale,
    bottom: (height - 1 - maxY) / scale,
  };
  if (Object.values(clearances).some((distance) => distance < minimumClearancePoints)) {
    throw new Error("Résumé page image has ink too close to the page edge");
  }
  return { width, height, inkPixels, inkRows, clearances };
}
