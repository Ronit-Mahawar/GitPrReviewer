import { describe, expect, it } from "vitest";
import { exportedDeclarations, extractSignatures, isTsLike, relativeImports } from "./signatures";

const users = `import { query } from "./db";
import type { Req } from "../http";
import { z } from "zod";
export { helper } from "./helper";

export interface Profile {
  name: string;
}

/** null until the user finishes onboarding */
export type MaybeProfile = Profile | null;

export async function findUserById(id: string): Promise<{ id: string } | undefined> {
  const rows = await query("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0];
}

function internalHelper() {
  return 1;
}

export const MAX_USERS = 100;
export const toUpper = (s: string): string => s.toUpperCase();
export const config: { port: number } = { port: 3000 };

export class UserStore {
  private cache = new Map<string, string>();
  constructor(private readonly prefix: string) {}
  get(id: string): string | undefined {
    return this.cache.get(this.prefix + id);
  }
}

export enum Role {
  Admin = "admin",
}
`;

describe("exportedDeclarations", () => {
  it("lists top-level exports with their line ranges (JSDoc included), skipping non-exported ones", () => {
    expect(exportedDeclarations(users, "src/users.ts")).toEqual([
      { name: "Profile", kind: "interface", startLine: 6, endLine: 8 },
      { name: "MaybeProfile", kind: "type", startLine: 10, endLine: 11 },
      { name: "findUserById", kind: "function", startLine: 13, endLine: 16 },
      { name: "MAX_USERS", kind: "variable", startLine: 22, endLine: 22 },
      { name: "toUpper", kind: "variable", startLine: 23, endLine: 23 },
      { name: "config", kind: "variable", startLine: 24, endLine: 24 },
      { name: "UserStore", kind: "class", startLine: 26, endLine: 32 },
      { name: "Role", kind: "enum", startLine: 34, endLine: 36 },
    ]);
  });

  it("returns nothing for a file with no exports, or one that doesn't parse cleanly", () => {
    expect(exportedDeclarations("const a = 1;", "a.ts")).toEqual([]);
    expect(() => exportedDeclarations("export function (", "a.ts")).not.toThrow();
  });
});

describe("extractSignatures", () => {
  const sigs = extractSignatures(users, "src/users.ts");

  it("keeps declarations and JSDoc but drops function bodies", () => {
    expect(sigs).toContain("export async function findUserById(id: string): Promise<{ id: string } | undefined>;");
    expect(sigs).not.toContain("SELECT * FROM users");
    expect(sigs).toContain("/** null until the user finishes onboarding */\nexport type MaybeProfile = Profile | null;");
    expect(sigs).toContain("export interface Profile {\n  name: string;\n}");
  });

  it("summarises variables: arrow functions by signature, typed consts by type, others by (short) value", () => {
    expect(sigs).toContain("export const toUpper = (s: string): string => …;");
    expect(sigs).toContain("export const config: { port: number };");
    expect(sigs).toContain("export const MAX_USERS = 100;");
  });

  it("shows classes as member signatures without bodies or private members", () => {
    expect(sigs).toContain("export class UserStore {\n  constructor(private readonly prefix: string);\n  get(id: string): string | undefined;\n}");
    expect(sigs).not.toContain("cache");
  });

  it("skips non-exported code and truncates long initializers", () => {
    expect(sigs).not.toContain("internalHelper");
    const long = `export const big = { ${Array.from({ length: 50 }, (_, i) => `k${i}: ${i}`).join(", ")} };`;
    expect(extractSignatures(long, "a.ts")).toMatch(/^export const big = \{ k0: 0, .* …;$/);
  });

  it("is empty when nothing is exported", () => {
    expect(extractSignatures("const a = 1;", "a.ts")).toBe("");
  });

  it("handles .tsx and .js files", () => {
    expect(extractSignatures("export function App() { return <div />; }", "App.tsx")).toBe("export function App();");
    expect(extractSignatures("export function add(a, b) { return a + b; }", "add.js")).toBe("export function add(a, b);");
  });
});

describe("relativeImports", () => {
  it("returns relative import and re-export specifiers only, once each", () => {
    expect(relativeImports(users + 'import { query as q } from "./db";\n', "src/users.ts")).toEqual(["./db", "../http", "./helper"]);
  });
});

describe("isTsLike", () => {
  it.each([["a.ts", true], ["a.tsx", true], ["a.mjs", true], ["types.d.ts", false], ["a.py", false], ["README.md", false]])("%s → %s", (path, expected) => {
    expect(isTsLike(path)).toBe(expected);
  });
});
