import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateCost } from "../pricing";
import { matchComments } from "../match";
import { calculateMetrics } from "../metrics";
import { assertAllowedRepo, assertEvalBranch, assertSafeRepoPath } from "./safety";
import type { DatasetCase, EvaluationRow, PredictedComment } from "../types";

const e2eDir=path.dirname(fileURLToPath(import.meta.url));
const projectDir=path.resolve(e2eDir,"../..");
const evalDir=path.resolve(projectDir,"eval");
function parseArgs(argv:string[]) { const out:Record<string,string|boolean>={}; for(let i=0;i<argv.length;i++){if(!argv[i].startsWith("--"))continue;const key=argv[i].slice(2);out[key]=argv[i+1]&&!argv[i+1].startsWith("--")?argv[++i]:true;}return out; }
function redact(value:string) {
  for(const name of ["GITHUB_TOKEN","GH_TOKEN","OPENAI_API_KEY","GEMINI_API_KEY"]) { const secret=process.env[name];if(secret)value=value.split(secret).join("[REDACTED]"); }
  return value
    .replace(/https?:\/\/[^\s/@:]+(?::[^\s/@]+)?@/g,"https://[REDACTED]@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+)\b/g,"[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,"Bearer [REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,"[REDACTED PRIVATE KEY]");
}
function sanitize(value:any):any { if(typeof value==="string")return redact(value);if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));return value; }
function command(bin:string,args:string[],cwd?:string) { return new Promise<string>((resolve,reject)=>{const child=spawn(bin,args,{cwd,stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",d=>out+=d);child.stderr.on("data",d=>err+=d);child.on("error",reject);child.on("close",code=>code===0?resolve(out.trim()):reject(new Error(redact(err||out||`${bin} exited ${code}`))));}); }
function gh(repo:string,args:string[]) { assertAllowedRepo(repo); return command("gh",args); }
function safeRepoPath(file:string) { assertSafeRepoPath(file); return path.join(...file.replaceAll("\\","/").split("/")); }
function commentList(value:unknown):PredictedComment[] { if(!Array.isArray(value))return[];return value.filter((c:any)=>c&&typeof c.file==="string"&&Number.isFinite(Number(c.line))).map((c:any)=>({file:c.file,line:Number(c.line),severity:c.severity,category:c.category,message:String(c.message??""),suggestion:c.suggestion})); }
function percentile(values:number[],q:number) { if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(q*sorted.length)-1]; }
async function loadCases():Promise<DatasetCase[]> { const dir=path.join(evalDir,"dataset");const names=(await readdir(dir)).filter(f=>f.endsWith(".json")).sort();return Promise.all(names.map(async n=>JSON.parse(await readFile(path.join(dir,n),"utf8")) as DatasetCase)); }
function selfcheckCases():DatasetCase[] {
  const docs="## Evaluation smoke case\n\nThis documentation-only change checks that PR review processing does not crash.\n";
  const large=Array.from({length:600},(_,i)=>`export const evalLine${i} = ${i};`).join("\n")+"\n";
  const make=(id:string,title:string,file:string,contents:string,scenario:string):DatasetCase=>({id,title,description:`Automated self-check: ${scenario}`,is_clean:true,ground_truth:[],scenario,files:{[file]:contents},diff:`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${contents?contents.split("\n").filter(Boolean).length:0} @@\n${contents.split("\n").filter(Boolean).map(line=>`+${line}`).join("\n")}\n`});
  return [make("selfcheck-docs-only","Self-check documentation PR","README-eval-selfcheck.md",docs,"docs-only"),make("selfcheck-large-diff","Self-check large diff PR","src/eval-large-selfcheck.ts",large,"large-diff"),make("selfcheck-empty-file","Self-check empty file PR","src/eval-empty-selfcheck.ts","","empty-file")];
}
async function estimateBulkCost(cases:DatasetCase[],model:string) {
  let sum=0;for(const c of cases){const promptTokens=Math.ceil((c.title.length+c.description.length+c.diff.length+1200)/4);const oneAttempt=estimateCost(model,promptTokens,3000);if(oneAttempt===null)return null;sum+=oneAttempt*3;}return sum;
}
function printDryRun(repo:string,cases:DatasetCase[],retrigger:boolean) { console.log(`Dry run: target ${repo}`);for(const c of cases){const branch=`eval/${c.id}-${new Date().toISOString().replace(/[:.]/g,"-")}`;assertEvalBranch(branch);console.log(`- create ${branch}, commit case files, open PR against main${retrigger?", push two empty commits to retrigger": ""}, poll stored review, match comments; close PR and delete ${branch}`);} }
async function loadDb(url:string) { const {PrismaClient}=await import("@prisma/client");return new PrismaClient({datasources:{db:{url}}}); }
async function storedReviews(db:any,repo:string,prNumber:number) { return db.review.findMany({where:{prNumber,repository:{fullName:repo}},orderBy:{createdAt:"asc"}}); }
async function pollReview(db:any,repo:string,prNumber:number,timeoutMs:number,intervalMs=5000) {
  const until=Date.now()+timeoutMs;let reviews:any[]=[];let maxConcurrent=0;
  do { reviews=await storedReviews(db,repo,prNumber);maxConcurrent=Math.max(maxConcurrent,reviews.filter(r=>["PENDING","PROCESSING"].includes(r.status)).length);if(reviews.length&&reviews.every(r=>!["PENDING","PROCESSING"].includes(r.status)))return {reviews,maxConcurrent};await new Promise(r=>setTimeout(r,intervalMs)); } while(Date.now()<until);
  return {reviews,maxConcurrent};
}
async function applyCase(repoDir:string,testCase:DatasetCase) {
  if(testCase.files){for(const [name,contents] of Object.entries(testCase.files)){const file=safeRepoPath(name);const target=path.join(repoDir,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,contents);}}
  else {
    for(const line of testCase.diff.split(/\r?\n/))if(line.startsWith("+++ b/"))safeRepoPath(line.slice(6).trim());
    const patchFile=path.join(os.tmpdir(),`gitpr-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);await writeFile(patchFile,testCase.diff);
    try{await command("git",["apply","--index",patchFile],repoDir);}finally{await rm(patchFile,{force:true});}
  }
}
function report(rows:any[]) {
  const counts={tp:0,fp:0,fn:0};for(const r of rows)for(const label of r.labels??[]){if(label==="TP")counts.tp++;else if(label==="FP"||label==="unmatched")counts.fp++;else if(label==="FN")counts.fn++;}
  const {precision,recall,f1}=calculateMetrics(counts);
  const latency=rows.map(r=>r.webhook_to_review_latency_ms).filter((x:any)=>typeof x==="number");const finished=rows.filter(r=>r.status==="COMPLETED").length;const failures=rows.filter(r=>r.failure_reason||r.cleanup_error);
  const n=(x:number|null)=>x===null?"N/A":x.toFixed(3);
  return `# GitHub E2E report\n\nCases: ${rows.length}\n\n- Success rate: ${rows.length?`${n(finished/rows.length*100)}%`:"N/A"}\n- PR creation to review record latency (ms), mean / median / p95: ${latency.length?`${n(latency.reduce((a:number,b:number)=>a+b,0)/latency.length)} / ${n(percentile(latency,.5))} / ${n(percentile(latency,.95))}`:"N/A"}\n- The app does not store webhook receive time, so PR-created to review-record-created is the observable proxy. Processing latency is recorded per case in JSONL.\n- Duplicate reviews: ${rows.reduce((a,r)=>a+(r.duplicate_reviews??0),0)}\n- Missing reviews: ${rows.filter(r=>r.missing_review).length}\n- Precision / recall / F1: ${n(precision)} / ${n(recall)} / ${n(f1)}\n\n## Failed cases\n\n${failures.length?failures.map(r=>`- ${r.case_id}: ${r.failure_reason??r.cleanup_error}`).join("\n"):"N/A"}\n\nRetries are N/A when the deployed review record does not expose Inngest attempt counts.\n`;
}
async function main() {
  const flags=parseArgs(process.argv.slice(2));
  const repo=String(flags.repo??"");assertAllowedRepo(repo);
  let cases=await loadCases();if(flags["selfcheck-scenarios"])cases.push(...selfcheckCases());if(flags.case)cases=cases.filter(c=>c.id===String(flags.case));if(flags.limit)cases=cases.slice(0,Number(flags.limit));
  if(!cases.length)throw new Error("No dataset cases selected.");
  const model=JSON.parse(await readFile(path.join(evalDir,"config.json"),"utf8")).model;
  const estimated=await estimateBulkCost(cases,model);
  if(estimated===null)throw new Error(`No price configured for model ${model}; update eval/pricing.ts before a live run.`);
  console.log(`Conservative LLM cost estimate (3 attempts per case): $${estimated.toFixed(6)} USD for ${cases.length} PR(s).`);
  if(flags["dry-run"]){printDryRun(repo,cases,Boolean(flags["retrigger-twice"]));return;}
  const approval=typeof flags["approve-cost"]==="string"?Number(flags["approve-cost"]):Number.NaN;if(!Number.isFinite(approval)||approval<estimated)throw new Error(`No LLM or GitHub actions were run. Re-run with --approve-cost ${estimated.toFixed(6)} after reviewing the estimate.`);
  if(!process.env.EVAL_E2E_DATABASE_URL)throw new Error("Set EVAL_E2E_DATABASE_URL to the sandbox app database used by the webhook; DATABASE_URL is intentionally not used.");
  const timeoutMs=Number(flags.timeout??300_000);const keep=Boolean(flags.keep);const runDir=path.resolve(String(flags.out??path.join(evalDir,"results",`e2e-${new Date().toISOString().replace(/[:.]/g,"-")}`)));
  await mkdir(path.dirname(runDir),{recursive:true});await mkdir(runDir);
  // Do not print gh auth details: the CLI must be authenticated, but its output can identify local account state.
  try { await command("gh",["auth","status","--hostname","github.com"]); } catch { throw new Error("GitHub CLI is not authenticated. Run gh auth login or set GITHUB_TOKEN; token values are never displayed."); }
  const actual=await gh(repo,["api",`repos/${repo}`,"--jq",".full_name"]);if(actual.toLowerCase()!==repo.toLowerCase())throw new Error("GitHub returned a repository outside the allowlisted target.");
  const db=await loadDb(process.env.EVAL_E2E_DATABASE_URL);const rows:any[]=[];
  try {
    for(const testCase of cases){
      const started=Date.now();const safeId=testCase.id.replace(/[^A-Za-z0-9._-]/g,"-");let branch=`eval/${safeId}-${new Date().toISOString().replace(/[:.]/g,"-")}`;assertEvalBranch(branch);
      let cloneDir="",cloneParent="",prNumber:number|null=null,pushed=false;let row:any={system:"gitprreviewer-e2e",case_id:testCase.id,scenario:testCase.scenario??null,retrigger_count:0,run:1,diff:sanitize(testCase.diff),is_clean:testCase.is_clean,ground_truth:sanitize(testCase.ground_truth),raw_output:null,comments:[],status:"MISSING",labels:[],retry_count:null,success:false,failure_reason:null,duplicate_reviews:0,missing_review:true,webhook_to_review_latency_ms:null,review_processing_latency_ms:null};
      try {
        cloneParent=await mkdtemp(path.join(os.tmpdir(),"gitpr-e2e-clone-"));cloneDir=path.join(cloneParent,"repo");
        await gh(repo,["repo","clone",repo,cloneDir,"--","--single-branch","--branch","main"]);
        const origin=await command("git",["remote","get-url","origin"],cloneDir);const slug=origin.replace(/^git@github\.com:/,"https://github.com/").replace(/^https:\/\/github\.com\//," ").trim().replace(/\.git$/i,"");if(slug.toLowerCase()!==repo.toLowerCase())throw new Error("Clone origin does not match the allowlisted repository.");
        await command("git",["config","user.name","GitPrReviewer E2E"],cloneDir);await command("git",["config","user.email","gitprreviewer-e2e@example.invalid"],cloneDir);
        await command("git",["switch","-c",branch],cloneDir);await applyCase(cloneDir,testCase);
        await command("git",["add","-A"],cloneDir);await command("git",["commit","-m",`test: evaluation case ${testCase.id}`],cloneDir);
        assertAllowedRepo(repo);assertEvalBranch(branch);await command("git",["push","--set-upstream","origin",branch],cloneDir);pushed=true;
        const url=await gh(repo,["pr","create","--repo",repo,"--base","main","--head",branch,"--title",`[eval] ${testCase.title}`,"--body",`Automated evaluation case ${testCase.id}.\n\n${testCase.description}`]);const match=url.match(/\/pull\/(\d+)/);if(!match)throw new Error("Could not read PR number from gh output.");prNumber=Number(match[1]);
        if(flags["retrigger-twice"]){for(let i=1;i<=2;i++){await command("git",["commit","--allow-empty","-m",`test: retrigger evaluation ${i}`],cloneDir);assertAllowedRepo(repo);assertEvalBranch(branch);await command("git",["push","origin",branch],cloneDir);row.retrigger_count++;}}
        const createdAt=Date.parse(await gh(repo,["pr","view",String(prNumber),"--repo",repo,"--json","createdAt","--jq",".createdAt"]));
        const observed=await pollReview(db,repo,prNumber,timeoutMs,flags["retrigger-twice"]?1000:5000);const reviews=observed.reviews;row.max_concurrent_reviews=observed.maxConcurrent;row.pr_number=prNumber;row.pr_url=url;row.elapsed_ms=Date.now()-started;row.missing_review=reviews.length===0;row.duplicate_reviews=Math.max(0,reviews.length-1);
        if(reviews.length){const first=reviews[0],last=reviews[reviews.length-1];row.status=last.status;row.review_statuses=reviews.map((r:any)=>r.status);row.review_count=reviews.length;row.raw_output=sanitize({summary:last.summary,riskScore:last.riskScore,comments:last.comments,error:last.error});row.comments=sanitize(commentList(last.comments));row.failure_reason=last.status==="FAILED"?redact(String(last.error??"Review failed")):!["COMPLETED","FAILED"].includes(last.status)?`Review remained ${last.status} after ${timeoutMs}ms.`:null;row.webhook_to_review_latency_ms=Number.isFinite(createdAt)?new Date(first.createdAt).getTime()-createdAt:null;row.review_processing_latency_ms=["COMPLETED","FAILED"].includes(last.status)?new Date(last.updatedAt).getTime()-new Date(first.createdAt).getTime():null;row.retry_count=null;row.success=last.status==="COMPLETED";
          const matched=matchComments(row.comments,testCase.ground_truth,3);row.labels=matched.labels.map(x=>x.auto_label);row.missed_truth=matched.missed_truth.map(i=>testCase.ground_truth[i]);row.fn_count=matched.missed_truth.length;row.labels.push(...matched.missed_truth.map(()=>"FN"));
        } else {row.status="MISSING";row.failure_reason=`No stored review observed within ${timeoutMs}ms.`;row.elapsed_ms=Date.now()-started;}
      } catch(error:any){row.status="ERROR";row.failure_reason=redact(error?.message??String(error));row.elapsed_ms=Date.now()-started;}
      finally {
        if(!keep){try{if(prNumber!==null)await gh(repo,["pr","close",String(prNumber),"--repo",repo,"--comment","Evaluation run complete."]);if(pushed){assertAllowedRepo(repo);assertEvalBranch(branch);await gh(repo,["api","--method","DELETE",`repos/${repo}/git/refs/heads/${branch}`]);}}catch(error:any){row.cleanup_error=redact(error?.message??String(error));}}
        if(cloneParent)await rm(cloneParent,{recursive:true,force:true});
      }
      rows.push(row);console.log(`${testCase.id}: ${row.status}${row.failure_reason?` — ${row.failure_reason}`:""}`);
    }
  } finally { await db.$disconnect(); }
  const file=await open(path.join(runDir,"results.jsonl"),"wx");for(const row of rows)await file.write(`${JSON.stringify(row)}\n`);await file.close();
  await writeFile(path.join(runDir,"e2e-report.md"),report(rows));await writeFile(path.join(runDir,"config.json"),await readFile(path.join(evalDir,"config.json"),"utf8"));await writeFile(path.join(runDir,"repo.txt"),repo+"\n");
  console.log(`Wrote results to ${runDir}`);
}
main().catch(error=>{console.error(redact(error?.message??String(error)));process.exitCode=1;});
