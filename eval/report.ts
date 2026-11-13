import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const evalDir=path.dirname(fileURLToPath(import.meta.url));
function n(value:any,digits=3) { return value===null||value===undefined||Number.isNaN(value)?"N/A":typeof value==="number"?value.toFixed(digits):String(value); }
function ci(value:any) { return Array.isArray(value)?`[${n(value[0])}, ${n(value[1])}]`:"N/A"; }
function table(headers:string[],rows:any[][]) { return `| ${headers.join(" | ")} |\n| ${headers.map(()=>"---").join(" | ")} |\n${rows.map(r=>`| ${r.map(v=>String(v??"N/A").replaceAll("|","\\|")).join(" | ")} |`).join("\n")}`; }
async function main() {
  const runDir=path.resolve(process.argv[2]??""); if(!process.argv[2])throw new Error("Usage: tsx eval/report.ts <run-directory>");
  const {execFileSync}=await import("node:child_process"); execFileSync("python3",[path.join(evalDir,"analyze.py"),runDir],{stdio:"inherit"});
  const data=JSON.parse(await readFile(path.join(runDir,"analysis.json"),"utf8"));
  const metrics=data.metrics.map((s:any)=>[s.system,n(s.precision),ci(s.precision_ci),n(s.recall),ci(s.recall_ci),n(s.f1),ci(s.f1_ci),n(s.clean_fp_rate),n(s.mean_latency_ms,1),n(s.cost_per_pr,6)]);
  const operations=data.metrics.map((s:any)=>[s.system,n(s.median_latency_ms,1),n(s.p95_latency_ms,1),n(s.prompt_tokens_per_pr,1),n(s.completion_tokens_per_pr,1),n(s.severity_accuracy),n(s.category_accuracy),n(s.success_rate),s.retries,n(s.run_consistency)]);
  const bugRows=data.per_bug_type.map((s:any)=>[s.system,s.bug_type,n(s.precision),n(s.recall),n(s.f1),s.tp,s.fp,s.fn]);
  const runConfig=JSON.parse(await readFile(path.join(runDir,"config.json"),"utf8").catch(()=>"{}"));
  const ablations=data.metrics.map((s:any)=>[s.system,s.system==="zero_shot"?"bare_prompt":s.system==="eslint"?"static_analysis":runConfig.prompt_variant??"N/A",s.system==="zero_shot"||s.system==="eslint"?"diff":runConfig.context??"N/A",n(s.precision),n(s.recall),n(s.f1),n(s.cost_per_pr,6)]);
  const sig=data.significance.map((s:any)=>[s.system_a,s.system_b,n(s.statistic),n(s.p_value)]);
  const exampleRows=JSON.parse(await readFile(path.join(runDir,"examples.json"),"utf8").catch(()=>"[]"));
  const meta=JSON.parse(await readFile(path.join(runDir,"run-metadata.json"),"utf8").catch(()=>"{}"));
  const report=`# Evaluation report\n\nRun: ${path.basename(runDir)}\n\nModel: ${runConfig.model??"N/A"}; runs per case: ${runConfig.runs??"N/A"}; seed: ${runConfig.seed??"N/A"}.\n\n${meta.dry_run?"> **Dry run:** predictions are synthetic fixtures from ground truth; these metrics are a pipeline smoke check and are not model performance results.\n\n":""}## System comparison\n\n${table(["System","Precision","P 95% CI","Recall","R 95% CI","F1","F1 95% CI","FP / clean PR","Mean latency ms","Cost / PR USD"],metrics)}\n\n## Additional metrics\n\n${table(["System","Median latency ms","p95 latency ms","Prompt tokens / PR","Completion tokens / PR","Severity accuracy","Category accuracy","Success rate","Retries","Run consistency"],operations)}\n\n## Per bug type\n\n${table(["System","Bug type","Precision","Recall","F1","TP","FP","FN"],bugRows)}\n\n## Ablations\n\n${table(["System","Prompt variant","Context","Precision","Recall","F1","Cost / PR USD"],ablations)}\n\n## Paired significance tests\n\n${table(["System A","System B","Statistic","p-value"],sig)}\n\nThe paired Wilcoxon signed-rank test treats cases as independent pairs, assumes the paired F1 differences are approximately symmetric, and may be unreliable with many ties or zero differences.\n\n## Qualitative examples\n\n### True positives\n\n${formatExamples(exampleRows.filter((r:any)=>r.kind==="TP"))}\n\n### False positives\n\n${formatExamples(exampleRows.filter((r:any)=>r.kind==="FP"))}\n\n## Human ratings\n\n${table(["System","Dimension","Mean","SD","N"],data.ratings.map((r:any)=>[r.system,r.dimension,n(r.mean),n(r.sd),r.n]))}\n\nAgreement: ${data.kappa.method}: ${n(data.kappa.value)}. Ratings are N/A until eval/ratings.csv contains completed ratings.\n\n## Charts\n\n![Precision, recall, and F1](prf1.png)\n\n![Latency by diff size](latency_vs_diff.png)\n\n![Cost by system](cost_per_system.png)\n`;
  await writeFile(path.join(runDir,"report.md"),report); console.log(`Wrote ${path.join(runDir,"report.md")}`);
}
function formatExamples(rows:any[]) { return rows.length?rows.slice(0,5).map((r:any)=>`- **${r.system} / ${r.case_id}** ${r.comment_text} — ${r.file}:${r.line} (${r.auto_label})`).join("\n"):"N/A"; }
main().catch(e=>{console.error(e);process.exitCode=1;});
