/** Reconstructs the visible post-change hunk text; provide case.files for complete-file context. */
export function reconstructFiles(diff: string): Record<string, string> {
  const result: Record<string, string> = {}; let file = ""; let lines: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { if (file) result[file] = lines.join("\n"); file = line.slice(6).trim(); lines = []; }
    else if (/^\+[^+]/.test(line)) lines.push(line.slice(1));
    else if (/^ [^]/.test(line)) lines.push(line.slice(1));
  }
  if (file) result[file] = lines.join("\n");
  return result;
}
