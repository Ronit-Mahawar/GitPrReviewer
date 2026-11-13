# Offline AI review evaluation

Run commands from `aicodereviewer/`. The harness reads local JSON cases and writes a new timestamped directory under `eval/results/`; it refuses to reuse an existing output directory.

## From setup to report

1. Install Node dependencies with `npm install`. For charts and statistics, create a Python environment and run `python3 -m pip install -r eval/requirements.txt`.
2. Add cases following [dataset/README.md](dataset/README.md). The repository includes six seeded bugs and two clean examples.
3. Copy `.env.example` to `.env.local`, then set the API key value in `OPENAI_API_KEY` or `GEMINI_API_KEY`. The CLI reads those values from the shell, `.env.local`, or `.env`. Both adapters use the app's Gemini OpenAI-compatible endpoint by default to keep the model backend consistent; `EVAL_BASE_URL` overrides the zero-shot adapter endpoint. The project review function continues to use its existing Gemini base URL.
4. Run a no-cost smoke run: `npm run eval:run -- --system gitprreviewer --dry-run --limit 2 --runs 1`. Dry-run predictions are synthetic comments derived from ground truth, so they validate file flow only and must not be reported as model results.
5. Run a system: `npm run eval:run -- --system gitprreviewer --runs 3 --out eval/results/study-01`. Other adapters are `zero_shot` and `eslint`. Systems can be comma-separated. `--model`, `--prompt-variant default|zero_shot`, `--context diff|diff+file`, `--limit`, and `--tolerance` override config values.
6. Open `labeling.csv` and enter a human decision (`TP`, `FP`, or `FN`) plus optional notes for each predicted comment or missed bug. In a blind pass, use `blind_labeling.csv`; keep `blind_key.csv` separate until labeling is complete. Import an edited full-schema file with `npx tsx eval/label.ts import eval/results/study-01 eval/results/study-01/labeling.csv`. Human labels override automatic labels during analysis.
7. Optionally collect human ratings in `eval/ratings.csv` using [ratings_template.csv](ratings_template.csv). Correctness, usefulness, actionability, and clarity are integers from 1–5. Keep one row per rater, case, and system.
8. Generate statistics and report: `npm run eval:report -- eval/results/study-01`. Outputs include `report.md`, CSV tables, `analysis.json`, and PNG charts. You can separately rerun `npm run eval:analyze -- eval/results/study-01` after editing labels.

## Results and interpretation

`results.jsonl` has one record per system, case, and run, including the raw response, normalized comments, latency, available usage, estimated cost, success, retries, and errors. Token counts unavailable from the provider or adapter are `null`; cost then reports as N/A. The comparison report includes precision/recall/F1 confidence intervals, per-type metrics, clean-case false positives per clean PR, latency, estimated token/cost totals, reliability, run consistency, paired per-case Wilcoxon tests, ratings, and qualitative examples. Missing values are shown as N/A.

The Python analysis uses 1,000 case-level bootstrap resamples with the fixed seed in `config.json`. The model seed is passed to the OpenAI-compatible chat completion calls; if your provider rejects it, remove `seed` from `eval/config.json`. Paired Wilcoxon assumes independent cases, paired measurements, and approximately symmetric paired differences; ties and zero differences can weaken its interpretation. Cohen's kappa is computed for two raters and Fleiss' kappa for three or more, using correctness scores as categories. Install the pinned Python libraries in `requirements.txt` before analyzing.

Estimated provider cost is `prompt_tokens × input_price_per_million / 1,000,000 + completion_tokens × output_price_per_million / 1,000,000`, averaged per PR. The Gemini 3.1 Flash-Lite paid standard rates in [pricing.ts](pricing.ts) were checked against [Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing) on 2026-11-03; edit them for your tier and re-check before publishing. Unlisted models or unavailable usage report as N/A. Prices are estimates and don't include retries or other provider fees beyond the logged token usage.

Before a paper run, manually review labels, add enough cases for the intended sample (target 30–50, about 10 clean), collect classmates' ratings, confirm provider price entries, and retain the config, commit hash, and result directory with the paper materials.
