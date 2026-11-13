import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchComments } from "./match";
const evalDir=path.dirname(fileURLToPath(import.meta.url));
import type { DatasetCase, EvaluationRow } from "./types";

const columns=["system","case_id","run","comment_text","file","line","auto_label","human_label","notes"];
function csv(value: unknown) { const s=String(value??""); return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s; }
export function encodeCsv(rows: any[], names=columns) { return [names.join(","),...rows.map(r=>names.map(k=>csv(r[k])).join(","))].join("\n")+"\n"; }
function decodeCsv(text:string) { const rows:string[][]=[]; let row:string[]=[], cell="", quoted=false; for(let i=0;i<text.length;i++){const c=text[i]; if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===","){row.push(cell);cell="";}else if(c==="\n"){row.push(cell);rows.push(row);row=[];cell="";}else if(c!=="\r")cell+=c;} if(cell||row.length){row.push(cell);rows.push(row);} const [head,...data]=rows; return data.map(r=>Object.fromEntries(head.map((h,i)=>[h,r[i]??""]))); }
export async function exportLabels(rows:any[],out:string) {
  try {
    const old=decodeCsv(await readFile(path.join(out,"labeling.csv"),"utf8"));
    const byKey=new Map(old.map(r=>[`${r.system}\u0000${r.case_id}\u0000${r.run}\u0000${r.comment_text}\u0000${r.file}\u0000${r.line}`,r]));
    rows=rows.map(r=>{const previous=byKey.get(`${r.system}\u0000${r.case_id}\u0000${r.run}\u0000${r.comment_text}\u0000${r.file}\u0000${r.line}`);return previous?{...r,human_label:previous.human_label,notes:previous.notes}:r;});
  } catch { /* First export for this run. */ }
  await writeFile(path.join(out,"labeling.csv"),encodeCsv(rows));
  const blind=rows.map((r,i)=>({blind_id:`B${String(i+1).padStart(5,"0")}`,case_id:r.case_id,run:r.run,comment_text:r.comment_text,file:r.file,line:r.line,auto_label:r.auto_label,human_label:r.human_label,notes:r.notes}));
  for(let i=blind.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[blind[i],blind[j]]=[blind[j],blind[i]];}
  await writeFile(path.join(out,"blind_labeling.csv"),encodeCsv(blind,["blind_id","case_id","run","comment_text","file","line","auto_label","human_label","notes"]));
  await writeFile(path.join(out,"blind_key.csv"),encodeCsv(blind.map((r,i)=>({blind_id:r.blind_id,system:rows.find(x=>x.case_id===r.case_id&&x.run===r.run&&x.comment_text===r.comment_text&&x.file===r.file&&x.line===r.line)?.system})),["blind_id","system"]));
}
// Import filled human labels and retain the automatic label for auditability.
export async function importLabels(input:string,runDir:string) {
  const imported=decodeCsv(await readFile(input,"utf8"));
  if(imported.some(r=>!r.case_id||!("human_label" in r))) throw new Error("Imported CSV must include case_id and human_label columns.");
  if(imported.some(r=>r.human_label && !["TP","FP","FN"].includes(r.human_label.trim().toUpperCase()))) throw new Error("human_label must be TP, FP, FN, or empty.");
  let normalized=imported;
  if(imported.some(r=>r.blind_id)) {
    const key=decodeCsv(await readFile(path.join(runDir,"blind_key.csv"),"utf8")); const systems=new Map(key.map(r=>[r.blind_id,r.system]));
    if(imported.some(r=>!systems.has(r.blind_id))) throw new Error("Blind CSV contains an unknown blind_id; confirm it belongs to this run.");
    normalized=imported.map(r=>({system:systems.get(r.blind_id)??"",case_id:r.case_id,run:r.run,comment_text:r.comment_text,file:r.file,line:r.line,auto_label:r.auto_label,human_label:r.human_label,notes:r.notes}));
  }
  await writeFile(path.join(runDir,"labeling.csv"),encodeCsv(normalized));
}
if(process.argv[1]?.endsWith("label.ts")){
  const [cmd,runDir,input]=process.argv.slice(2);
  if(cmd==="import"&&input) importLabels(input,runDir).then(()=>console.log(`Imported labels into ${path.join(runDir,"labeling.csv")}`)).catch(e=>{console.error(e);process.exitCode=1;});
  else if(cmd==="export"&&runDir) (async()=>{
    const rows=(await readFile(path.join(runDir,"results.jsonl"),"utf8")).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)) as EvaluationRow[];
    const cases:DatasetCase[]=[]; for(const f of await (await import("node:fs/promises")).readdir(path.join(evalDir,"dataset"))){if(f.endsWith(".json"))cases.push(JSON.parse(await readFile(path.join(evalDir,"dataset",f),"utf8")));}
    const config=JSON.parse(await readFile(path.join(runDir,"config.json"),"utf8"));
    const labels:any[]=[]; for(const row of rows){const c=cases.find(x=>x.id===row.case_id);if(!c)continue;const result=matchComments(row.comments,c.ground_truth,config.line_tolerance??3);row.comments.forEach((x,i)=>labels.push({system:row.system,case_id:row.case_id,run:row.run,comment_text:x.message,file:x.file,line:x.line,auto_label:result.labels[i].auto_label,human_label:"",notes:""}));result.missed_truth.forEach(i=>{const g=c.ground_truth[i];labels.push({system:row.system,case_id:row.case_id,run:row.run,comment_text:`MISSED: ${g.description}`,file:g.file,line:g.line_start,auto_label:"FN",human_label:"",notes:"Ground-truth bug not matched"});});}
    await exportLabels(labels,runDir);console.log(`Exported labels to ${path.join(runDir,"labeling.csv")}`);
  })().catch(e=>{console.error(e);process.exitCode=1;});
  else { console.error("Usage: tsx eval/label.ts export <run-dir> | import <run-dir> <filled-csv>");process.exitCode=1; }
}
