import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { inspectPdfPageImage } from "../dist/src/resume/visual-qa.js";

const require = createRequire(import.meta.url);
const standardFontDataUrl = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
const warmups = 3;
const samples = 30;

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: Number(median(sorted).toFixed(2)),
    p95: Number(sorted[Math.ceil(0.95 * samples) - 1].toFixed(2)) };
}

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([612, 792]);
  page.drawText("Example Candidate", { x: 42, y: 750, size: 18, font: bold });
  page.drawText("SOFTWARE ENGINEERING", { x: 42, y: 721, size: 12, font: bold });
  for (let line = 0; line < 26; line += 1) {
    page.drawText(`Built reliable Python services for project ${line + 1} using tested APIs`,
      { x: 42, y: 690 - line * 23, size: 10, font: regular });
  }
  return await pdf.save();
}

const bytes = await fixture();
const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true, standardFontDataUrl });
try {
  const document = await task.promise;
  const page = await document.getPage(1);
  const text = await page.getTextContent();
  const regions = text.items.flatMap((item) => "str" in item && item.str.trim()
    ? [{ x: item.transform[4], y: item.transform[5], width: item.width,
      height: Math.abs(item.height), text: item.str }] : []);
  const render = [];
  const inspect = [];
  const total = [];
  let dimensions;
  for (let index = 0; index < warmups + samples; index += 1) {
    const result = await inspectPdfPageImage(page, regions);
    dimensions = { width: result.width, height: result.height };
    if (index < warmups) continue;
    render.push(result.timingsMs.render);
    inspect.push(result.timingsMs.inspect);
    total.push(result.timingsMs.render + result.timingsMs.inspect);
  }
  process.stdout.write(JSON.stringify({
    fixture: "synthetic one-page 28-line text PDF", fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
    node: process.version, os: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown",
    dimensions, warmups, samples,
    milliseconds: { render: summary(render), inspect: summary(inspect), total: summary(total) },
  }, null, 2) + "\n");
} finally {
  await task.destroy();
}
