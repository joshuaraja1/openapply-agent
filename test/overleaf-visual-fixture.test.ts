import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, it } from "vitest";
import { inspectPdfPageImage } from "../src/resume/visual-qa.js";

it("accepts legible Jake-template text while excluding narrow contact separators", async () => {
  const document = await PDFDocument.create();
  const pageFixture = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const draw = (value: string, x: number, y: number) =>
    pageFixture.drawText(value, { x, y, font, size: 10 });
  draw("Synthetic Candidate", 42, 740);
  draw("candidate@example.com", 42, 720);
  draw("|", 180, 720);
  draw("portfolio.example", 200, 720);
  draw("|", 330, 720);
  draw("github.example", 350, 720);
  draw("Experience", 42, 680);
  draw("•", 42, 660);
  draw("Built sample Python services", 54, 660);
  draw("•", 42, 640);
  draw("Improved synthetic test coverage", 54, 640);
  const bytes = await document.save();
  const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true });
  try {
    const page = await (await task.promise).getPage(1);
    const items = (await page.getTextContent()).items;
    const text = items.filter((item) => "str" in item).map((item) => item.str);
    expect(text.filter((value) => value.trim() === "|")).toHaveLength(2);
    expect(text.filter((value) => value.trim() === "•")).toHaveLength(2);
    expect(text.join(" ")).toContain("Built sample Python services");
    const substantiveRegions = items.flatMap((item) => {
      if (!("str" in item) || !item.str.trim() || ["|", "•"].includes(item.str.trim())
        || item.width <= 0 || item.height <= 0) return [];
      return [{ x: item.transform[4]!, y: item.transform[5]!,
        width: item.width, height: Math.abs(item.height) }];
    });
    await expect(inspectPdfPageImage(page, substantiveRegions))
      .resolves.toMatchObject({ width: 918, height: 1188 });
  } finally { await task.destroy(); }
});
