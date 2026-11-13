/** Only the owner-confirmed sandbox repository is authorized for GitHub actions. */
export const ALLOWED_SANDBOX_REPOS = new Set<string>(["Ronit-Mahawar/Learning-Rag"]);

export function assertAllowedRepo(repo: string, allowlist = ALLOWED_SANDBOX_REPOS): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !allowlist.has(repo)) {
    throw new Error("Refusing GitHub operation: target repo is not in the hard-coded sandbox allowlist.");
  }
}

export function assertEvalBranch(branch: string): void {
  if (!branch.startsWith("eval/") || branch.includes("..")) {
    throw new Error("Refusing branch operation: only eval/* branches are allowed.");
  }
}

export function assertSafeRepoPath(file: string): void {
  const normalized = file.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.includes("\0") || normalized.split("/").some((part) => part === "..") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Unsafe path in dataset diff: ${file}`);
  }
}
