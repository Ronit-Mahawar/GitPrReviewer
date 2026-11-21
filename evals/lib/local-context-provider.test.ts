import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalContextProvider } from "./local-context-provider";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ctx-"));
  mkdirSync(join(root, "src/routes"), { recursive: true });
  writeFileSync(join(root, "src/users.ts"), "export async function findUser(id: string) {\n  return id;\n}\nexport const findUserCount = 1;\n");
  writeFileSync(
    join(root, "src/routes/get.ts"),
    'import { findUser } from "../users";\n\nexport async function handler() {\n  const u = await findUser("1");\n  return u;\n}\n',
  );
  writeFileSync(join(root, "notes.md"), "findUser is mentioned here too\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("createLocalContextProvider", () => {
  it("reads a file relative to the root", async () => {
    expect(await createLocalContextProvider(root).getFile("src/users.ts", "HEAD")).toContain("findUser");
  });

  it("returns null for a missing file and for paths outside the root", async () => {
    const ctx = createLocalContextProvider(root);
    expect(await ctx.getFile("src/missing.ts", "HEAD")).toBeNull();
    expect(await ctx.getFile("../etc/passwd", "HEAD")).toBeNull();
  });

  it("finds whole-word call sites in .ts files, skipping imports, declarations and other file types", async () => {
    const callers = await createLocalContextProvider(root).findCallers("findUser", "HEAD");
    expect(callers.map((c) => [c.file, c.line])).toEqual([["src/routes/get.ts", 4]]);
    expect(callers[0]!.snippet).toContain('await findUser("1")');
  });

  it("returns no callers for an unused symbol, and treats regex characters literally", async () => {
    const ctx = createLocalContextProvider(root);
    expect(await ctx.findCallers("nothing", "HEAD")).toEqual([]);
    expect(await ctx.findCallers("find.ser", "HEAD")).toEqual([]);
  });
});
