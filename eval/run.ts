import { readdir, readFile, mkdir, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchComments } from "./match";
import { estimateCost } from "./pricing";
import type { DatasetCase, EvaluationRow, PredictedComment } from "./types";
const evalDir=path.dirname(fileURLToPath(import.meta.url));

function args(argv: string[]) { const out: Record<string, string | boolean> = {}; for (let i=0;i<argv.length;i++) { if (!argv[i].startsWith("--")) continue; const k=argv[i].slice(2); out[k] = argv[i+1] && !argv[i+1].startsWith("--") ? argv[++i] : true; } return out; }
async function loadLocalEnv() {
  for (const file of [".env.local",".env"]) {
    try { const source=await readFile(path.resolve(file),"utf8"); for(const line of source.split(/\r?\n/)) { const match=line.match(/^\s*(OPENAI_API_KEY|GEMINI_API_KEY|EVAL_BASE_URL)\s*=\s*(.*?)\s*$/); if(!match||process.env[match[1]])continue; process.env[match[1]]=match[2].replace(/\s+#.*$/,"").replace(/^(['"])(.*)\1$/,"$2"); } } catch { /* Environment variables can be supplied by the shell or CI instead. */ }
  }
}
function isTransient(error: any) { return error?.status === 408 || error?.status === 409 || error?.status === 429 || error?.status >= 500 || error?.name === "APIConnectionError" || error?.name === "TimeoutError"; }
async function loadCases(): Promise<DatasetCase[]> { const dir=path.join(evalDir,"dataset"); return (await readdir(dir)).filter(f=>f.endsWith(".json")).sort().map(async f=>JSON.parse(await readFile(path.join(dir,f),"utf8")) as DatasetCase).reduce(async (acc,p)=>[...(await acc),await p],Promise.resolve([] as DatasetCase[])); }
async function main() {
  await loadLocalEnv();
  const options=args(process.argv.slice(2)); const systems=String(options.system ?? "gitprreviewer").split(",");
  const config=JSON.parse(await readFile(path.join(evalDir,"config.json"),"utf8"));
  const runs=Number(options.runs ?? config.runs); const model=String(options.model ?? config.model); const seed=Number(options.seed ?? config.seed);
  const promptVariant=String(options["prompt-variant"] ?? config.prompt_variant); const context=String(options.context ?? config.context);
  let out=String(options.out ?? path.join(import.meta.dirname,"results",new Date().toISOString().replace(/[:.]/g,"-")));
  out=path.resolve(out); await mkdir(path.dirname(out),{recursive:true});
  try { await mkdir(out); } catch (e:any) { if(e.code==="EEXIST") throw new Error(`Output directory already exists; choose a fresh path: ${out}`); throw e; }
  await writeFile(path.join(out,".eval-run-marker"),"GitPrReviewer evaluation run\n");
    await writeFile(path.join(out,"config.json"),JSON.stringify({...config,model,runs,seed,prompt_variant:promptVariant,context,line_tolerance:Number(options.tolerance ?? config.line_tolerance)},null,2));
  await writeFile(path.join(out,"run-metadata.json"),JSON.stringify({dry_run:Boolean(options["dry-run"]),systems,cases_selected:options.limit?Number(options.limit):null,created_at:new Date().toISOString()},null,2));
  let commit="unknown"; try { commit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(); } catch { /* Source snapshot may not be a git checkout. */ }
  await writeFile(path.join(out,"git-commit.txt"),commit+"\n");
  let cases=await loadCases(); if (options.limit) cases=cases.slice(0,Number(options.limit));
  const rows: EvaluationRow[]=[];
  for (const system of systems) {
    const modulePath=path.join(evalDir,"systems",`${system}.ts`);
    let adapter:any=null;
    if (!options["dry-run"]) { try { adapter=await import(pathToFileURL(modulePath).href); } catch { throw new Error(`Unknown evaluation system: ${system}`); } }
    for (const testCase of cases) for(let run=1;run<=runs;run++) {
      let retries=0; const retry_log:string[]=[]; const start=Date.now(); let result:any; let errorText:string|undefined;
      if (options["dry-run"]) {
        const comments:PredictedComment[]=testCase.ground_truth.map(g=>({file:g.file,line:g.line_start,severity:g.severity,category:g.bug_type===null?"bug":(["sql_injection","xss","hardcoded_secret"].includes(g.bug_type)?"security":"bug"),bug_type:g.bug_type,message:`Mock finding: ${g.description}`}));
        result={raw_output:{dry_run:true,fixture:"synthetic ground-truth-shaped comments"},comments,summary:"Dry-run fixture output",prompt_tokens:0,completion_tokens:0};
      } else {
        while(true) { try { result=await adapter.run({testCase,model,promptVariant,context,seed}); break; } catch(error:any) { retries++; const message=error?.message ?? String(error); if(retries<=2 && isTransient(error)) {retry_log.push(message); console.warn(`${system} ${testCase.id} run ${run}: retry ${retries}/2: ${message}`); continue;} errorText=message; break; } }
      }
      const latency_ms=Date.now()-start; const success=!errorText;
      rows.push({system,case_id:testCase.id,run,raw_output:result?.raw_output ?? null,comments:result?.comments ?? [],summary:result?.summary,riskScore:result?.riskScore,latency_ms,prompt_tokens:result?.prompt_tokens ?? null,completion_tokens:result?.completion_tokens ?? null,estimated_cost:estimateCost(model,result?.prompt_tokens ?? null,result?.completion_tokens ?? null),success,retries,retry_log,error:errorText});
      console.log(`${system} ${testCase.id} run ${run}: ${success?"ok":"failed"}${retries?` (${retries} retry)`:""}`);
    }
  }
  const handle=await open(path.join(out,"results.jsonl"),"wx");
  for(const row of rows) await handle.write(`${JSON.stringify(row)}\n`);
  await handle.close();
  const labelRows:any[]=[];
  for(const row of rows) { const testCase=cases.find(c=>c.id===row.case_id)!; const matched=matchComments(row.comments,testCase.ground_truth,Number(options.tolerance ?? config.line_tolerance));
    row.comments.forEach((comment,index)=>labelRows.push({system:row.system,case_id:row.case_id,run:row.run,comment_text:comment.message,file:comment.file,line:comment.line,auto_label:matched.labels[index].auto_label,human_label:"",notes:""}));
    matched.missed_truth.forEach(i=>{const bug=testCase.ground_truth[i];labelRows.push({system:row.system,case_id:row.case_id,run:row.run,comment_text:`MISSED: ${bug.description}`,file:bug.file,line:bug.line_start,auto_label:"FN",human_label:"",notes:"Ground-truth bug not matched"});});
  }
  const {exportLabels}=await import("./label"); await exportLabels(labelRows,out);
  console.log(`Saved ${rows.length} result rows to ${out}`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
