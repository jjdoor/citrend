# citrend

**Is your CI actually getting worse, or does it just feel that way?** GitHub Actions shows you one run at a time — nobody's tracking whether this month's success rate is better or worse than last month's, or how much compute your failures have actually burned. `citrend` pulls your workflow run history into a local file and gives you the trend. No dashboard account, no server.

```bash
npx citrend sync --repo owner/name
npx citrend report --repo owner/name
```

## Why

> "Curious what your pipeline success rate looks like. Has anyone else tracked the actual wasted compute time?"

That's a real question from a thread where someone had calculated their CI failures were burning a quarter of their compute budget — and found no lightweight way to track it over time, only heavyweight CI platforms with their own dashboards. `citrend` is a zero-dependency CLI answer: pull your run history locally, see the trend.

## Example

```
$ citrend report --repo acme/widgets

acme/widgets — 812 run(s) (2 in progress)

  success rate:    87.4%  (699/800 settled, 12 skipped)
  wasted runs:     101 (12.6%)
  total compute:   118h 42m
  wasted compute:  14h 6m

  weekly trend (oldest → newest):
    2026-06-05  91.2% success, 8 wasted (58m)
    2026-06-12  88.0% success, 11 wasted (1h 22m)
    2026-06-19  79.4% success, 22 wasted (3h 8m)
    2026-06-26  84.1% success, 15 wasted (2h 1m)
```

Watching that weekly column is the whole point — a single `gh run list` doesn't show you that week 3 was a cliff.

## Commands

```bash
citrend sync --repo <owner/name> [--workflow <file-or-id>] [--branch <b>] [--token <t>] [--limit N]
citrend report --repo <owner/name> [--since <dur>] [--weeks N] [--json]
```

- `sync` pulls recent workflow runs from the GitHub Actions API and appends the new ones to local history — safe to run repeatedly (e.g. on a schedule or before every `report`); it dedupes by run id.
- `report` reads local history only — no network call — and prints overall stats plus a weekly trend.
- `--token`, or `$GITHUB_TOKEN` / `$GH_TOKEN`, raises the GitHub API rate limit from 60 req/hr (unauthenticated) to 5000 req/hr. A public repo works fine unauthenticated for occasional syncing.

## What counts as "wasted"

A run is wasted if it settled (has a conclusion) and that conclusion isn't `success` or `skipped` — so `failure`, `cancelled`, `timed_out`, and anything else GitHub reports all count. Still-running runs aren't counted either way until they conclude. "Compute" is wall-clock duration (`run_started_at` → `updated_at`) as reported by the Actions API — a reasonable proxy for spent runner time, not an exact billed-minutes figure (which needs a separate, higher-overhead per-job timing call).

## Storage

History is cached at `~/.citrend/<owner>__<repo>/runs.jsonl` — **not** committed to the repo it tracks, since (unlike a hand-written record) this is just a local mirror of data GitHub already stores. Override with `--dir` or `$CITREND_HOME`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | ok |
| `2` | usage error, bad repo, or GitHub API error (rate limit, 404, network) |

## License

MIT
