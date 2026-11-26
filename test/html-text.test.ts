import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/lib/text.js";

describe("HTML job description text", () => {
  it("keeps visible content and decodes entities once", () => {
    expect(htmlToText("<p>Build &amp; test APIs</p><p>Know &amp;lt;SQL&amp;gt; &nbsp; well</p>"))
      .toBe("Build & test APIs Know &lt;SQL&gt; well");
  });

  it("does not include script, style, comments, or their malformed closing tags", () => {
    expect(htmlToText('Before<script>alert(1)</script foo="bar"><style>secret</style><!-- hidden -->After'))
      .toBe("Before After");
  });

  it("does not treat encoded tags as markup after decoding", () => {
    expect(htmlToText("&lt;script&gt;keep as text&lt;/script&gt;"))
      .toBe("<script>keep as text</script>");
  });
});
