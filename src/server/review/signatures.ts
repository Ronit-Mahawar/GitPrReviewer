/**
 * Reads TypeScript/JavaScript source with the TypeScript compiler API (D9) to find:
 *   - exported declarations and the lines they span (to know which exports a diff changed)
 *   - their signatures without function bodies (cheap "contract" context for files a change imports)
 *   - relative imports (which files to take signatures from)
 * Only parses; never type-checks, so it needs no tsconfig and no other files.
 */
import * as ts from "typescript";

export interface ExportedDeclaration {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable";
  /** 1-based, including the declaration's JSDoc. */
  startLine: number;
  endLine: number;
}

const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MAX_INITIALIZER_CHARS = 160;

export function isTsLike(path: string): boolean {
  return TS_LIKE.test(path) && !path.endsWith(".d.ts");
}

function parse(source: string, fileName: string): ts.SourceFile {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Top-level exported declarations with their line ranges. */
export function exportedDeclarations(source: string, fileName: string): ExportedDeclaration[] {
  const sf = parse(source, fileName);
  const out: ExportedDeclaration[] = [];
  for (const stmt of sf.statements) {
    if (!isExported(stmt)) continue;
    const range = { startLine: lineOf(sf, stmt.getStart(sf, true)), endLine: lineOf(sf, stmt.end) };
    if (ts.isFunctionDeclaration(stmt) && stmt.name) out.push({ name: stmt.name.text, kind: "function", ...range });
    else if (ts.isClassDeclaration(stmt) && stmt.name) out.push({ name: stmt.name.text, kind: "class", ...range });
    else if (ts.isInterfaceDeclaration(stmt)) out.push({ name: stmt.name.text, kind: "interface", ...range });
    else if (ts.isTypeAliasDeclaration(stmt)) out.push({ name: stmt.name.text, kind: "type", ...range });
    else if (ts.isEnumDeclaration(stmt)) out.push({ name: stmt.name.text, kind: "enum", ...range });
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.text, kind: "variable", ...range });
      }
    }
  }
  return out;
}

/** Source text from the node's JSDoc (if any) up to, but not including, `end`. */
function textUpTo(sf: ts.SourceFile, node: ts.Node, end: number): string {
  return sf.text.slice(node.getStart(sf, true), end).trimEnd();
}

function variableSignature(sf: ts.SourceFile, stmt: ts.VariableStatement): string {
  const keyword = stmt.declarationList.flags & ts.NodeFlags.Const ? "const" : stmt.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
  const jsDoc = sf.text.slice(stmt.getStart(sf, true), stmt.getStart(sf)).trim();
  const lines = stmt.declarationList.declarations.map((decl) => {
    const name = decl.name.getText(sf);
    const init = decl.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      // `export const f = async (a: A): Promise<B> => …;`
      return `export ${keyword} ${name} = ${sf.text.slice(init.getStart(sf), init.body.getStart(sf)).trimEnd()} …;`;
    }
    if (decl.type) return `export ${keyword} ${name}: ${decl.type.getText(sf)};`;
    if (init) {
      const text = init.getText(sf).replace(/\s+/g, " ");
      return `export ${keyword} ${name} = ${text.length > MAX_INITIALIZER_CHARS ? `${text.slice(0, MAX_INITIALIZER_CHARS)} …` : text};`;
    }
    return `export ${keyword} ${name};`;
  });
  return [jsDoc, ...lines].filter(Boolean).join("\n");
}

function classSignature(sf: ts.SourceFile, cls: ts.ClassDeclaration): string {
  const header = sf.text.slice(cls.getStart(sf, true), cls.members.pos).trimEnd(); // up to and including "{"
  const members = cls.members
    .filter((m) => !(ts.canHaveModifiers(m) && (ts.getModifiers(m) ?? []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)))
    .map((m) => {
      if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body) {
        return `  ${textUpTo(sf, m, m.body.getStart(sf)).trim()};`;
      }
      return `  ${m.getText(sf).trim()}`;
    });
  return [header, ...members, "}"].join("\n");
}

/** Exported declarations as signatures: no function bodies, JSDoc kept. Empty string if nothing is exported. */
export function extractSignatures(source: string, fileName: string): string {
  const sf = parse(source, fileName);
  const parts: string[] = [];
  for (const stmt of sf.statements) {
    if (!isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt)) parts.push(stmt.body ? `${textUpTo(sf, stmt, stmt.body.getStart(sf))};` : stmt.getText(sf));
    else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) parts.push(textUpTo(sf, stmt, stmt.end));
    else if (ts.isClassDeclaration(stmt)) parts.push(classSignature(sf, stmt));
    else if (ts.isVariableStatement(stmt)) parts.push(variableSignature(sf, stmt));
  }
  return parts.join("\n\n");
}

/** Module specifiers of relative imports and re-exports ("./db", "../users"), in source order, without duplicates. */
export function relativeImports(source: string, fileName: string): string[] {
  const sf = parse(source, fileName);
  const specifiers: string[] = [];
  for (const stmt of sf.statements) {
    const spec = (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
    if (spec && spec.startsWith(".") && !specifiers.includes(spec)) specifiers.push(spec);
  }
  return specifiers;
}
