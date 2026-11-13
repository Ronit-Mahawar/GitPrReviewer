import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconstructFiles } from "../diff";
import type { GroundTruth } from "../types";

const e2eDir=path.dirname(fileURLToPath(import.meta.url));
const projectDir=path.resolve(e2eDir,"../..");
interface Check { name:string; passed:boolean; reason:string; reproduction:string; }
function args(argv:string[]) { const out:Record<string,string|boolean>={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith("--"))continue;const k=argv[i].slice(2);out[k]=argv[i+1]&&!argv[i+1].startsWith("--")?argv[++i]:true;}return out; }
function parseHunkLines(diff:string) {
  const files=new Map<string,Set<number>>();let file="",line=0;
  for(const raw of diff.split(/\r?\n/)) {
    if(raw.startsWith("+++ b/")){file=raw.slice(6).trim();if(!files.has(file))files.set(file,new Set());continue;}
    const hunk=raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);if(hunk){line=Number(hunk[1]);continue;}
    if(raw.startsWith("+")&&!raw.startsWith("+++")){files.get(file)?.add(line++);continue;}
    if(raw.startsWith(" ")){files.get(file)?.add(line++);continue;}
  }
  return files;
}
async function invalidSignatureCheck():Promise<boolean> {
  process.env.DATABASE_URL ||= "postgresql://selfcheck:selfcheck@127.0.0.1:5432/selfcheck";
  const old=process.env.GITHUB_WEBHOOK_SECRET;process.env.GITHUB_WEBHOOK_SECRET="selfcheck-only-secret";
  try {
    const {POST}=await import("../../src/app/api/webhooks/github/route");
    const response=await POST(new Request("http://localhost/api/webhooks/github",{method:"POST",body:"{}",headers:{"x-hub-signature-256":`sha256=${"0".repeat(64)}`,"x-github-event":"pull_request","x-github-delivery":"selfcheck-bad-signature"}}) as any);
    return response.status===401;
  } finally { if(old===undefined)delete process.env.GITHUB_WEBHOOK_SECRET;else process.env.GITHUB_WEBHOOK_SECRET=old; }
}
async function failedReviewTest():Promise<{passed:boolean;detail:string}> {
  const output=path.join(os.tmpdir(),`gitpr-selfcheck-${Date.now()}.json`);
  const cli=path.join(projectDir,"node_modules","vitest","vitest.mjs");
  const result=await new Promise<{code:number|null;stderr:string}>((resolve)=>{const child=spawn(process.execPath,[cli,"run","src/server/inngest/functions/review-pr.test.ts","--reporter=json",`--outputFile=${output}`],{cwd:projectDir,stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",d=>stderr+=d);child.on("close",code=>resolve({code,stderr}));child.on("error",()=>resolve({code:1,stderr:"Unable to launch Vitest"}));});
  try { const report=JSON.parse(await readFile(output,"utf8"));const assertion=report.testResults?.flatMap((r:any)=>r.assertionResults??[]).find((x:any)=>x.fullName?.includes("ends the stored review in a terminal state"));return {passed:assertion?.status==="passed",detail:assertion?.status==="failed"?"Mocked LLM failure leaves the review PROCESSING after all configured attempts.":"The retry-state test did not produce an assertion result."}; }
  catch { return {passed:false,detail:result.stderr.trim()||"Could not read the retry-state test result."}; }
  finally { await import("node:fs/promises").then(({rm})=>rm(output,{force:true})); }
}
async function main() {
  const flags=args(process.argv.slice(2));
  if(flags["dry-run"]){console.log("Planned self-check evidence: clean PR, hardcoded-secret PR, duplicate retriggers, large diff, docs-only and empty-file PRs, bad webhook signature, forced LLM failure, and diff line mapping.");return;}
  if(!flags["run-dir"])throw new Error("Usage: npm run eval:selfcheck -- --run-dir eval/results/e2e-<run>");
  const runDir=path.resolve(String(flags["run-dir"]));let rows:any[]=[];
  try{rows=(await readFile(path.join(runDir,"results.jsonl"),"utf8")).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));}catch{/* Missing evidence becomes an explicit failed check below. */}
  const checks:Check[]=[];
  const add=(name:string,passed:boolean,reason:string,reproduction:string)=>checks.push({name,passed,reason,reproduction});
  const clean=rows.filter((r:any)=>r.is_clean===true&&r.status==="COMPLETED");
  add("Clean PR has zero high-severity findings",clean.length>0&&clean.every(r=>!r.comments.some((c:any)=>["high","critical"].includes(String(c.severity).toLowerCase()))),clean.length?"":"No completed clean-PR result is present.","Run a clean dataset case with eval:e2e, wait for COMPLETED, and inspect stored comments.");
  const secret=rows.find((r:any)=>r.ground_truth?.some((g:GroundTruth)=>g.bug_type==="hardcoded_secret"));
  const secretTruth=secret?.ground_truth.find((g:GroundTruth)=>g.bug_type==="hardcoded_secret");
  const secretFound=Boolean(secret&&secretTruth&&secret.comments.some((c:any)=>c.file===secretTruth.file&&Math.abs(c.line-secretTruth.line_start)<=3&&/secret|credential|api.?key/i.test(c.message)));
  add("Planted hardcoded secret is flagged",secretFound,"No matching security comment was found for the planted secret.","Run dataset case 05-hardcoded-secret and inspect comments on the secret line.");
  const repeated=rows.filter((r:any)=>Number(r.retrigger_count)>=2);
  const duplicateSafe=repeated.length>0&&repeated.every((r:any)=>Number(r.max_concurrent_reviews??0)<=1);
  add("Two retriggers do not create concurrent duplicates",duplicateSafe,repeated.length?"Duplicate review records were observed without a clear single-active-review guarantee.":"No case was re-triggered twice.","Run eval:e2e with --case 07-clean-format --retrigger-twice and compare review records for the same PR.");
  const large=rows.find((r:any)=>r.scenario==="large-diff");
  const largeLines=large?.diff?.split(/\r?\n/).filter((l:string)=>l.startsWith("+")&&!l.startsWith("+++ ")).length??0;
  add("Large diff completes or fails gracefully",Boolean(large&&largeLines>500&&["COMPLETED","FAILED"].includes(large.status)),"No completed or terminal large-diff scenario is present.","Run eval:e2e with --selfcheck-scenarios --case selfcheck-large-diff and confirm a terminal status.");
  const simple=rows.filter((r:any)=>["docs-only","empty-file"].includes(r.scenario));
  add("Docs-only or empty-file PR does not crash",simple.length>0&&simple.every((r:any)=>["COMPLETED","FAILED"].includes(r.status)),"No terminal docs-only or empty-file scenario is present.","Run eval:e2e with --selfcheck-scenarios and inspect docs-only / empty-file rows.");
  let signaturePassed=false;try{signaturePassed=await invalidSignatureCheck();}catch{/* A thrown handler error is a failed rejection check. */}
  add("Webhook rejects a bad signature",signaturePassed,"Bad signature did not return HTTP 401.","POST a raw body with an invalid x-hub-signature-256; the handler must return 401 before DB access.");
  const failure=await failedReviewTest();
  add("Failed LLM call is retried and reaches terminal state",failure.passed,failure.detail,"Mock reviewCode to reject for all three Inngest attempts; verify Prisma status becomes FAILED or COMPLETED, never PROCESSING.");
  const commentRows=rows.filter((r:any)=>r.status==="COMPLETED");
  const linesOkay=commentRows.length>0&&commentRows.every((r:any)=>{const lines=parseHunkLines(r.diff??"");return r.comments.every((c:any)=>lines.get(c.file)?.has(Number(c.line))===true);});
  add("Comment line numbers exist in the diff",linesOkay,"No completed review was available or a comment points outside visible unified-diff lines.","Compare each saved comment file and line with the + side and context lines in its PR diff.");
  console.log("Self-check results:");for(const check of checks)console.log(`${check.passed?"PASS":"FAIL"} ${check.name}${check.passed?"":` — ${check.reason}`}`);
  const failures=checks.filter(c=>!c.passed);const markdown=`# E2E self-check\n\n${checks.map(c=>`- **${c.passed?"PASS":"FAIL"} — ${c.name}**${c.passed?"":`\n  - Finding: ${c.reason}\n  - Reproduction: ${c.reproduction}`}`).join("\n")}\n`;
  await writeFile(path.join(runDir,"selfcheck-report.md"),markdown);if(failures.length)process.exitCode=1;
}
main().catch(error=>{console.error(error?.message??String(error));process.exitCode=1;});
