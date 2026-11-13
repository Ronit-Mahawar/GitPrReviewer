# Evaluation dataset

Each `.json` file is one pull request case. Keep `id` unique; `diff` must be a unified diff whose `+++ b/` paths match the file names in `ground_truth`. `is_clean` should be true only when the change has no actionable bug. Clean cases must use an empty `ground_truth` list.

Each ground truth item has an inclusive line range in the new file, a listed `bug_type` (or `null` if a specific category is not meaningful), severity (`critical`, `high`, `medium`, `low`), and a short explanation of the defect and impact. Prefer the smallest range that identifies the faulty change. Line numbers should match the `+` side of the diff. Avoid labeling style preferences as bugs unless the category is `style`.

Add 30–50 cases total, including roughly 10 clean changes. Include realistic variations in file type, diff size, and bug severity. Do not put credentials or private source in the dataset. `files` is optional and can provide full post-change file contents for the `diff+file` context condition.
