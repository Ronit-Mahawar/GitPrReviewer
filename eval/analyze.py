"""Compute benchmark statistics from runner JSONL and the editable labeling CSV."""
import argparse, csv, json, math, os, random, statistics, tempfile
from collections import defaultdict
from pathlib import Path
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "gitprreviewer-matplotlib"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.stats import wilcoxon
from sklearn.metrics import cohen_kappa_score
from statsmodels.stats.inter_rater import fleiss_kappa

SEED = 42
BUG_TYPES = ["null_deref", "off_by_one", "sql_injection", "xss", "hardcoded_secret", "missing_error_handling", "race_condition", "logic_error", "resource_leak", "style", "other", "unspecified"]
def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
def read_csv(path):
    return list(csv.DictReader(path.open(newline="", encoding="utf-8"))) if path.exists() else []
def safe_div(a,b): return a/b if b else None
def metrics(counts):
    tp,fp,fn=counts["tp"],counts["fp"],counts["fn"]
    p=safe_div(tp,tp+fp); r=safe_div(tp,tp+fn)
    return {"precision":p,"recall":r,"f1":safe_div(2*p*r,p+r) if p is not None and r is not None and p+r else 0.0 if p==0 or r==0 else None}
def bootstrap(case_counts, key, n=1000):
    if not case_counts: return None
    rng=random.Random(SEED); vals=[]
    for _ in range(n):
        sample=[case_counts[rng.randrange(len(case_counts))] for __ in case_counts]
        total={k:sum(c[k] for c in sample) for k in ("tp","fp","fn")}; value=metrics(total)[key]
        if value is not None: vals.append(value)
    if not vals:return None
    vals.sort(); return [vals[int(.025*(len(vals)-1))],vals[int(.975*(len(vals)-1))]]
def run(args):
    root=Path(__file__).parent; out=Path(args.run_dir)
    config=json.loads((out/"config.json").read_text()) if (out/"config.json").exists() else {}
    global SEED
    SEED=int(config.get("seed",SEED))
    result_path=out/"results.jsonl"; rows=read_jsonl(result_path)
    labels=read_csv(out/"labeling.csv"); cases={c["id"]:c for c in (json.loads(p.read_text()) for p in (root/"dataset").glob("*.json"))}
    # Human labels take precedence. Unmatched predictions count as false positives for metrics.
    by_system_case=defaultdict(lambda:defaultdict(lambda:{"tp":0,"fp":0,"fn":0}))
    label_lookup={ (l["system"],l["case_id"],l["run"],l["comment_text"],l["file"],l["line"]): l.get("human_label","").strip().upper() for l in labels }
    for l in labels:
        label=(l.get("human_label") or l.get("auto_label") or "").upper()
        key=by_system_case[l["system"]][l["case_id"]]
        if label=="TP":key["tp"]+=1
        elif label=="FN":key["fn"]+=1
        elif label in ("FP","UNMATCHED"):key["fp"]+=1
    systems=sorted({r["system"] for r in rows}); summaries=[]; per_bug=[]; overall_accuracy=[0,0,0]; overall_consistency=[]
    for system in systems:
        sr=[r for r in rows if r["system"]==system]; ccs=[by_system_case[system][cid] for cid in cases]; total={k:sum(c[k] for c in ccs) for k in ("tp","fp","fn")}; m=metrics(total)
        lat=[r["latency_ms"] for r in sr if r.get("success")]; prompt=sum(r.get("prompt_tokens") or 0 for r in sr); completion=sum(r.get("completion_tokens") or 0 for r in sr); cost=[r["estimated_cost"] for r in sr if r.get("estimated_cost") is not None]
        clean_ids=[c["id"] for c in cases.values() if c["is_clean"]]; clean_fp=sum(by_system_case[system][cid]["fp"] for cid in clean_ids); clean_runs=sum(1 for r in sr if r["case_id"] in clean_ids)
        true_positive_labels=[l for l in labels if l["system"]==system and ((l.get("human_label") or l.get("auto_label") or "").upper()=="TP")]
        severity_correct=category_correct=0; truth_n=0
        for l in true_positive_labels:
            gt=next((g for g in cases[l["case_id"]]["ground_truth"] if g["file"]==l["file"] and abs(int(l["line"])-g["line_start"])<=3),None)
            if gt:
                truth_n+=1
                pred=next((c for r in sr if r["case_id"]==l["case_id"] and str(r["run"])==str(l["run"]) for c in r["comments"] if c["message"]==l["comment_text"]),None)
                if pred and pred.get("severity")==gt["severity"]:severity_correct+=1
                expected="security" if gt["bug_type"] in ("sql_injection","xss","hardcoded_secret") else ("style" if gt["bug_type"]=="style" else "performance" if gt["bug_type"] in ("race_condition","resource_leak") else "bug")
                if pred and pred.get("category")==expected:category_correct+=1
        overall_accuracy[0]+=severity_correct;overall_accuracy[1]+=category_correct;overall_accuracy[2]+=truth_n
        runs_by_case=defaultdict(list)
        for r in sr:runs_by_case[r["case_id"]].append(r)
        consistency=[]
        for cid, cruns in runs_by_case.items():
            truth=cases[cid]["ground_truth"]
            for bug in truth:
                found=sum(any((l.get("human_label") or l.get("auto_label") or "").upper()=="TP" and l["system"]==system and l["case_id"]==cid and str(l["run"])==str(rr["run"]) and l["file"]==bug["file"] and abs(int(l["line"])-bug["line_start"])<=3 for l in labels) for rr in cruns)
                consistency.append(found/len(cruns))
        overall_consistency.extend(consistency)
        summary={"system":system,**m,"precision_ci":bootstrap(ccs,"precision"),"recall_ci":bootstrap(ccs,"recall"),"f1_ci":bootstrap(ccs,"f1"),"clean_fp_rate":safe_div(clean_fp,clean_runs),"mean_latency_ms":statistics.mean(lat) if lat else None,"median_latency_ms":statistics.median(lat) if lat else None,"p95_latency_ms":sorted(lat)[min(len(lat)-1,math.ceil(.95*len(lat))-1)] if lat else None,"prompt_tokens_per_pr":safe_div(prompt,len(sr)),"completion_tokens_per_pr":safe_div(completion,len(sr)),"cost_per_pr":statistics.mean(cost) if cost else None,"severity_accuracy":safe_div(severity_correct,truth_n),"category_accuracy":safe_div(category_correct,truth_n),"success_rate":safe_div(sum(bool(r.get("success")) for r in sr),len(sr)),"retries":sum(r.get("retries",0) for r in sr),"run_consistency":statistics.mean(consistency) if consistency else None}
        summaries.append(summary)
        for bug_type in BUG_TYPES:
            related={cid for cid,c in cases.items() if any((g["bug_type"] or "unspecified")==bug_type for g in c["ground_truth"])}
            bc={k:sum(by_system_case[system][cid][k] for cid in related) for k in ("tp","fp","fn")}; per_bug.append({"system":system,"bug_type":bug_type,**metrics(bc),**bc})
    if systems:
        all_ccs=[{k:sum(by_system_case[s][cid][k] for s in systems) for k in ("tp","fp","fn")} for cid in cases]
        all_counts={k:sum(c[k] for c in all_ccs) for k in ("tp","fp","fn")}
        all_rows=rows; all_lat=[r["latency_ms"] for r in all_rows if r.get("success")]; all_cost=[r["estimated_cost"] for r in all_rows if r.get("estimated_cost") is not None]
        clean_ids=[c["id"] for c in cases.values() if c["is_clean"]]; clean_fp=sum(by_system_case[s][cid]["fp"] for s in systems for cid in clean_ids); clean_runs=sum(1 for r in all_rows if r["case_id"] in clean_ids)
        summaries.append({"system":"overall",**metrics(all_counts),"precision_ci":bootstrap(all_ccs,"precision"),"recall_ci":bootstrap(all_ccs,"recall"),"f1_ci":bootstrap(all_ccs,"f1"),"clean_fp_rate":safe_div(clean_fp,clean_runs),"mean_latency_ms":statistics.mean(all_lat) if all_lat else None,"median_latency_ms":statistics.median(all_lat) if all_lat else None,"p95_latency_ms":sorted(all_lat)[min(len(all_lat)-1,math.ceil(.95*len(all_lat))-1)] if all_lat else None,"prompt_tokens_per_pr":safe_div(sum(r.get("prompt_tokens") or 0 for r in all_rows),len(all_rows)),"completion_tokens_per_pr":safe_div(sum(r.get("completion_tokens") or 0 for r in all_rows),len(all_rows)),"cost_per_pr":statistics.mean(all_cost) if all_cost else None,"severity_accuracy":safe_div(overall_accuracy[0],overall_accuracy[2]),"category_accuracy":safe_div(overall_accuracy[1],overall_accuracy[2]),"success_rate":safe_div(sum(bool(r.get("success")) for r in all_rows),len(all_rows)),"retries":sum(r.get("retries",0) for r in all_rows),"run_consistency":statistics.mean(overall_consistency) if overall_consistency else None})
        for bug_type in BUG_TYPES:
            selected=[r for r in per_bug if r["bug_type"]==bug_type]; counts={k:sum(r[k] for r in selected) for k in ("tp","fp","fn")};per_bug.append({"system":"overall","bug_type":bug_type,**metrics(counts),**counts})
    tests=[]
    f1_by={s["system"]:{cid:metrics(by_system_case[s["system"]][cid])["f1"] or 0 for cid in cases} for s in summaries}
    for i,a in enumerate(systems):
        for b in systems[i+1:]:
            av=[f1_by[a][cid] for cid in sorted(cases)];bv=[f1_by[b][cid] for cid in sorted(cases)]
            try:
                # Paired Wilcoxon assumes independent cases, paired measurements, and roughly symmetric paired differences; ties/zero differences can limit validity.
                if all(x==y for x,y in zip(av,bv)): tests.append({"system_a":a,"system_b":b,"statistic":None,"p_value":None})
                else:
                    stat,p=wilcoxon(av,bv,zero_method="wilcox",alternative="two-sided");tests.append({"system_a":a,"system_b":b,"statistic":float(stat) if math.isfinite(stat) else None,"p_value":float(p) if math.isfinite(p) else None})
            except ValueError:tests.append({"system_a":a,"system_b":b,"statistic":None,"p_value":None})
    dimensions=["correctness","usefulness","actionability","clarity"]
    ratings=[r for r in read_csv(root/"ratings.csv") if all(r.get(d) for d in dimensions)]
    if any(not (1 <= float(r[d]) <= 5) for r in ratings for d in dimensions): raise ValueError("Rating scores must be between 1 and 5")
    rating_summary=[]; kappa={"method":"N/A","value":None}
    for system in systems:
        vals=[{d:float(r[d]) for d in dimensions} for r in ratings if r.get("system")==system]
        for d in dimensions:
            data=[v[d] for v in vals]; rating_summary.append({"system":system,"dimension":d,"mean":statistics.mean(data) if data else None,"sd":statistics.stdev(data) if len(data)>1 else None,"n":len(data)})
    raters=sorted({r["rater"] for r in ratings}); units=sorted({(r["case_id"],r["system"]) for r in ratings})
    if len(raters)==2:
        lookup={(r["rater"],r["case_id"],r["system"]):r["correctness"] for r in ratings}; pairs=[(lookup[(raters[0],c,s)],lookup[(raters[1],c,s)]) for c,s in units if (raters[0],c,s) in lookup and (raters[1],c,s) in lookup]
        if pairs:
            value=float(cohen_kappa_score([x[0] for x in pairs],[x[1] for x in pairs]));kappa={"method":"Cohen's kappa (correctness; numeric ratings treated as categories)","value":value if math.isfinite(value) else None}
    elif len(raters)>=3:
        categories=[1,2,3,4,5]; matrix=[]
        for c,s in units:
            vals=[int(r["correctness"]) for r in ratings if r["case_id"]==c and r["system"]==s]
            if len(vals)==len(raters):matrix.append([vals.count(cat) for cat in categories])
        if matrix:
            value=float(fleiss_kappa(matrix));kappa={"method":"Fleiss' kappa (correctness)","value":value if math.isfinite(value) else None}
    write_csv(out/"metrics.csv",summaries);write_csv(out/"per_bug_type.csv",per_bug);write_csv(out/"significance.csv",tests);write_csv(out/"ratings_summary.csv",rating_summary)
    # Ablations are prompt/context conditions included as distinct system names or run configs.
    write_csv(out/"ablation.csv",[{"system":s["system"],"prompt_variant":"bare_prompt" if s["system"]=="zero_shot" else "static_analysis" if s["system"]=="eslint" else config.get("prompt_variant","N/A"),"context":"diff" if s["system"] in ("zero_shot","eslint") else config.get("context","N/A"),"precision":s["precision"],"recall":s["recall"],"f1":s["f1"],"cost_per_pr":s["cost_per_pr"]} for s in summaries])
    tp=[];fp=[]
    for l in labels:
        label=(l.get("human_label") or l.get("auto_label") or "").upper()
        if label in ("TP","FP"):(tp if label=="TP" else fp).append(l)
    example_rows=[{"kind":kind,**r} for kind,items in (("TP",tp[:5]),("FP",fp[:5])) for r in items]
    write_csv(out/"examples.csv",example_rows);(out/"examples.json").write_text(json.dumps(example_rows,indent=2))
    # Scatter uses actual test-case changed-line counts and per-run latency.
    size={cid:sum(1 for line in c["diff"].splitlines() if line.startswith(("+","-")) and not line.startswith(("+++","---"))) for cid,c in cases.items()}
    plt.figure();
    for s in systems:
        sr=[r for r in rows if r["system"]==s];plt.scatter([size.get(r["case_id"],0) for r in sr],[r["latency_ms"] for r in sr],label=s)
    plt.xlabel("Changed lines");plt.ylabel("Latency (ms)");plt.legend();plt.tight_layout();plt.savefig(out/"latency_vs_diff.png");plt.close()
    plt.figure();x=range(len(systems));width=.25
    for i,key in enumerate(("precision","recall","f1")):plt.bar([v+i*width for v in x],[next((s[key] for s in summaries if s["system"]==sys),0) or 0 for sys in systems],width,label=key)
    plt.xticks([v+width for v in x],systems,rotation=20);plt.ylim(0,1);plt.legend();plt.tight_layout();plt.savefig(out/"prf1.png");plt.close()
    plt.figure();plt.bar(systems,[next((s["cost_per_pr"] for s in summaries if s["system"]==sys),0) or 0 for sys in systems]);plt.ylabel("Estimated cost / PR (USD)");plt.tight_layout();plt.savefig(out/"cost_per_system.png");plt.close()
    report={"metrics":summaries,"per_bug_type":per_bug,"significance":tests,"ratings":rating_summary,"kappa":kappa}
    (out/"analysis.json").write_text(json.dumps(report,indent=2))
def write_csv(path,rows):
    fields=list(dict.fromkeys(k for r in rows for k in r)) or ["empty"]
    with path.open("w",newline="",encoding="utf-8") as f:w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(rows)
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("run_dir");run(p.parse_args())
