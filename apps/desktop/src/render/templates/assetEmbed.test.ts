import { describe, expect, test } from "vitest";
import {
  bytesToBase64,
  embedTemplateAssets,
  extractCssUrls,
  extractHtmlImageUrls,
  mimeFromUrl,
  rewriteCssUrls,
  rewriteHtmlImageSrcs,
} from "./assetEmbed";

describe("extractCssUrls", () => {
  test("finds single-quoted url() targets", () => {
    const css = `@font-face { src: url('./fonts/foo.woff2') format('woff2'); }`;
    expect(extractCssUrls(css)).toEqual(["./fonts/foo.woff2"]);
  });

  test("finds double-quoted and unquoted url() targets", () => {
    const css = `a { background: url("a.png"); } b { background: url(b.png); }`;
    expect(extractCssUrls(css)).toEqual(["a.png", "b.png"]);
  });

  test("dedupes repeated targets while preserving order", () => {
    const css = `a { background: url(a.png); } b { background: url(a.png); }`;
    expect(extractCssUrls(css)).toEqual(["a.png"]);
  });

  test("skips nothing — returns inline data: URLs too (caller filters)", () => {
    // Note: `embedTemplateAssets` is the one that filters data: out;
    // the extractor is a raw lister so other callers can audit.
    const css = `a { src: url(data:font/woff2;base64,AAA); }`;
    expect(extractCssUrls(css)).toEqual(["data:font/woff2;base64,AAA"]);
  });
});

describe("extractHtmlImageUrls", () => {
  test("finds img src in single and double quotes", () => {
    const html = `<img src="a.png" alt="x"><img src='b.png'>`;
    expect(extractHtmlImageUrls(html)).toEqual(["a.png", "b.png"]);
  });

  test("finds img src without quotes (sloppy markup)", () => {
    const html = `<img src=a.png>`;
    expect(extractHtmlImageUrls(html)).toEqual(["a.png"]);
  });

  test("ignores src on non-<img> elements", () => {
    const html = `<source src="audio.mp3"><img src="cover.png">`;
    expect(extractHtmlImageUrls(html)).toEqual(["cover.png"]);
  });
});

describe("rewriteCssUrls", () => {
  test("replaces matched targets with double-quoted data: URLs", () => {
    const css = `@font-face { src: url('foo.woff2'); }`;
    const out = rewriteCssUrls(
      css,
      new Map([["foo.woff2", "data:font/woff2;base64,AAA"]]),
    );
    expect(out).toBe(
      `@font-face { src: url("data:font/woff2;base64,AAA"); }`,
    );
  });

  test("leaves unmatched url() alone", () => {
    const css = `a { background: url(known.png); } b { background: url(other.png); }`;
    const out = rewriteCssUrls(css, new Map([["known.png", "REPLACED"]]));
    expect(out).toContain(`url("REPLACED")`);
    expect(out).toContain(`url(other.png)`);
  });
});

describe("rewriteHtmlImageSrcs", () => {
  test("replaces matched img src", () => {
    const html = `<img src="a.png">`;
    const out = rewriteHtmlImageSrcs(html, new Map([["a.png", "REPLACED"]]));
    expect(out).toBe(`<img src="REPLACED">`);
  });

  test("preserves quote style and other attributes", () => {
    const html = `<img class="logo" src='a.png' width="48">`;
    const out = rewriteHtmlImageSrcs(html, new Map([["a.png", "REPLACED"]]));
    expect(out).toBe(`<img class="logo" src='REPLACED' width="48">`);
  });

  test("leaves unmatched img src alone", () => {
    const html = `<img src="known.png"><img src="other.png">`;
    const out = rewriteHtmlImageSrcs(
      html,
      new Map([["known.png", "REPLACED"]]),
    );
    expect(out).toContain(`src="REPLACED"`);
    expect(out).toContain(`src="other.png"`);
  });
});

describe("mimeFromUrl", () => {
  test("maps font extensions", () => {
    expect(mimeFromUrl("a.woff2")).toBe("font/woff2");
    expect(mimeFromUrl("a.woff")).toBe("font/woff");
    expect(mimeFromUrl("a.ttf")).toBe("font/ttf");
    expect(mimeFromUrl("a.otf")).toBe("font/otf");
  });

  test("maps image extensions", () => {
    expect(mimeFromUrl("a.png")).toBe("image/png");
    expect(mimeFromUrl("a.JPG")).toBe("image/jpeg");
    expect(mimeFromUrl("a.jpeg")).toBe("image/jpeg");
    expect(mimeFromUrl("a.svg")).toBe("image/svg+xml");
    expect(mimeFromUrl("a.webp")).toBe("image/webp");
  });

  test("handles query strings + fragments + unknowns", () => {
    expect(mimeFromUrl("a.png?v=2")).toBe("image/png");
    expect(mimeFromUrl("a.woff2#hash")).toBe("font/woff2");
    expect(mimeFromUrl("noext")).toBe("application/octet-stream");
    expect(mimeFromUrl("a.zzz")).toBe("application/octet-stream");
  });
});

describe("bytesToBase64", () => {
  test("encodes small byte arrays", () => {
    // "abc" → "YWJj"
    const out = bytesToBase64(new Uint8Array([0x61, 0x62, 0x63]));
    expect(out).toBe("YWJj");
  });

  test("encodes empty input", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });
});

describe("embedTemplateAssets", () => {
  test("inlines a resolved css font as a data: url", async () => {
    const css = `@font-face { font-family: 'X'; src: url('x.woff2') format('woff2'); }`;
    const html = `<div>hi</div>`;
    const out = await embedTemplateAssets({
      html,
      css,
      fetchAsset: async (url) => {
        if (url === "x.woff2") return new Uint8Array([0x61, 0x62, 0x63]);
        return null;
      },
    });
    expect(out.css).toContain(`url("data:font/woff2;base64,YWJj")`);
    expect(out.embedded).toEqual(["x.woff2"]);
    expect(out.skipped).toEqual([]);
  });

  test("inlines a resolved img as a data: url", async () => {
    const html = `<img src="logo.png">`;
    const out = await embedTemplateAssets({
      html,
      css: "",
      fetchAsset: async (url) =>
        url === "logo.png" ? new Uint8Array([0x61]) : null,
    });
    expect(out.html).toBe(`<img src="data:image/png;base64,YQ==">`);
    expect(out.embedded).toEqual(["logo.png"]);
  });

  test("records skipped urls separately when resolver returns null", async () => {
    const css = `@font-face { src: url('missing.woff2'); }`;
    const out = await embedTemplateAssets({
      html: "",
      css,
      fetchAsset: async () => null,
    });
    expect(out.css).toContain(`url('missing.woff2')`);
    expect(out.embedded).toEqual([]);
    expect(out.skipped).toEqual(["missing.woff2"]);
  });

  test("never asks the resolver for inline data: urls", async () => {
    const calls: string[] = [];
    const css = `@font-face { src: url(data:font/woff2;base64,AAA); }`;
    const html = `<img src="data:image/png;base64,AAA">`;
    const out = await embedTemplateAssets({
      html,
      css,
      fetchAsset: async (url) => {
        calls.push(url);
        return null;
      },
    });
    expect(calls).toEqual([]);
    expect(out.embedded).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  test("dedupes a url referenced from both CSS and HTML — one resolver call", async () => {
    let calls = 0;
    const out = await embedTemplateAssets({
      html: `<img src="shared.png">`,
      css: `.x { background: url(shared.png); }`,
      fetchAsset: async () => {
        calls += 1;
        return new Uint8Array([0x61]);
      },
    });
    expect(calls).toBe(1);
    expect(out.html).toContain(`data:image/png;base64,YQ==`);
    expect(out.css).toContain(`data:image/png;base64,YQ==`);
  });
});
