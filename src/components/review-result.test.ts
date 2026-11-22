import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverageLine, readCoverage } from "./review-result";

const meta = { filesReviewed: 15, chunks: 2, failedChunks: 0, filesSkipped: [{ file: "package-lock.json", reason: "lockfile" }] };
const render = (m: unknown) => renderToStaticMarkup(createElement(CoverageLine, { meta: m }));

describe("CoverageLine", () => {
  it("shows files reviewed, parts and skipped files with reasons", () => {
    const html = render(meta);
    expect(html).toContain("15 files reviewed in 2 parts · 1 skipped");
    expect(html).toContain("<code>package-lock.json</code>: lockfile");
    expect(html).not.toContain("failed");
  });

  it("highlights failed parts", () => {
    expect(render({ ...meta, failedChunks: 1 })).toContain("1 of 2 parts failed");
  });

  it("renders nothing for reviews saved before v2 (no meta)", () => {
    expect(render(null)).toBe("");
    expect(render({ promptTokens: 5 })).toBe("");
  });

  it("uses singular wording for one file in one part", () => {
    expect(render({ filesReviewed: 1, chunks: 1, failedChunks: 0, filesSkipped: [] })).toContain("1 file reviewed · 0 skipped");
  });
});

describe("readCoverage", () => {
  it("tolerates a missing skipped list", () => {
    expect(readCoverage({ filesReviewed: 1, chunks: 1, failedChunks: 0 })?.filesSkipped).toEqual([]);
  });
});
