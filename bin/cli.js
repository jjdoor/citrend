#!/usr/bin/env node
'use strict';

const core = require('../src/core.js');
const store = require('../src/store.js');
const github = require('../src/github.js');

const VERSION = require('../package.json').version;
const now = () => Date.now();

// ----- tiny color helpers (no dep) -----
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (c, s) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = (s) => col('31', s), green = (s) => col('32', s), yellow = (s) => col('33', s), dim = (s) => col('2', s), bold = (s) => col('1', s);

const HELP = `${bold('citrend')} — track your CI pipeline's success rate and wasted compute over time. Local, no server.

${bold('Pull history')}
  citrend sync --repo <owner/name> [--workflow <file-or-id>] [--branch <b>] [--token <t>] [--limit N]

${bold('Report')}
  citrend report --repo <owner/name> [--since <dur>] [--weeks N] [--json]

${bold('Options')}
  --token <t>       GitHub token (else $GITHUB_TOKEN / $GH_TOKEN, else unauthenticated: 60 req/hr)
  --limit N         sync: max runs to pull per run (default 200)
  --since <dur>     report: only include runs started within this window, e.g. 30d
  --weeks N         report: how many weekly trend buckets to show (default 8)
  --dir <path>      override state location (default ~/.citrend)

${bold('Exit')}  0 ok   2 usage or network error
`;

function fail(msg) {
  process.stderr.write(red(`citrend: ${msg}\n`));
  process.exit(2);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}
function has(args, name) { return args.includes(name); }

const POSITIVE_INT_RE = /^\d+$/;

// Strict positive-integer parse — deliberately not `parseInt`, whose
// leniency (`parseInt('5abc')` === 5) diverges from Python's `int()`
// (raises on the same input), which would give `--limit`/`--weeks` a
// different accept/reject verdict depending on which build ran it.
function parsePositiveInt(raw) {
  if (raw === undefined || !POSITIVE_INT_RE.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

// Requires exactly one slash — "owner/repo/extra" is rejected rather than
// silently truncated, so a fat-fingered extra segment (or a pasted URL
// fragment like "owner/repo/actions") fails loudly instead of quietly
// running against the wrong repo.
function parseRepo(spec) {
  if (!spec) return null;
  const parts = spec.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function resolveToken(args) {
  return flag(args, '--token') || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
}

async function cmdSync(args) {
  const repoSpec = flag(args, '--repo');
  const parsed = parseRepo(repoSpec);
  if (!parsed) return fail('needs --repo <owner/name>');
  const { owner, repo } = parsed;

  let limit = 200;
  if (has(args, '--limit')) {
    limit = parsePositiveInt(flag(args, '--limit'));
    if (limit === null) return fail('--limit must be a positive integer');
  }
  const workflow = flag(args, '--workflow');
  const branch = flag(args, '--branch');
  const dir = flag(args, '--dir');
  const token = resolveToken(args);

  process.stdout.write(dim(`fetching runs for ${owner}/${repo}${workflow ? ` (workflow: ${workflow})` : ''}...\n`));
  let raw;
  try {
    raw = await github.fetchWorkflowRuns({ owner, repo, token, workflow, branch, limit });
  } catch (e) {
    return fail(e.message);
  }
  const normalized = raw.map(core.normalizeRun);
  const added = store.appendNewRuns(owner, repo, normalized, dir);
  process.stdout.write(green(`✓ pulled ${normalized.length} run(s), ${added} new — saved to ${store.runsPath(owner, repo, dir)}\n`));
}

function fmtPct(rate) {
  return rate === null ? 'n/a' : `${Math.round(rate * 1000) / 10}%`;
}

function printReport(owner, repo, stats, buckets) {
  process.stdout.write(`${bold(`${owner}/${repo}`)} — ${stats.total} run(s) (${stats.inProgress} in progress)\n\n`);
  const rateColor = stats.successRate === null ? dim : stats.successRate >= 0.9 ? green : stats.successRate >= 0.7 ? yellow : red;
  process.stdout.write(`  success rate:    ${rateColor(fmtPct(stats.successRate))}  (${stats.success}/${stats.settled - stats.skipped} settled, ${stats.skipped} skipped)\n`);
  process.stdout.write(`  wasted runs:     ${stats.wasted} (${fmtPct(stats.wastedRate)})\n`);
  process.stdout.write(`  total compute:   ${core.formatDuration(stats.totalDurationMs)}\n`);
  process.stdout.write(`  wasted compute:  ${red(core.formatDuration(stats.wastedDurationMs))}\n`);

  if (buckets.length > 0) {
    process.stdout.write(`\n  ${bold('weekly trend')} (oldest → newest):\n`);
    for (const b of buckets) {
      const label = new Date(b.start).toISOString().slice(0, 10);
      const bar = b.stats.settled === 0
        ? dim('no runs')
        : `${fmtPct(b.stats.successRate)} success, ${b.stats.wasted} wasted (${core.formatDuration(b.stats.wastedDurationMs)})`;
      process.stdout.write(`    ${label}  ${bar}\n`);
    }
  }
}

function cmdReport(args) {
  const repoSpec = flag(args, '--repo');
  const parsed = parseRepo(repoSpec);
  if (!parsed) return fail('needs --repo <owner/name>');
  const { owner, repo } = parsed;
  const dir = flag(args, '--dir');
  const asJson = has(args, '--json');

  const sinceRaw = flag(args, '--since');
  let sinceMs = null;
  if (sinceRaw !== undefined) {
    try {
      sinceMs = now() - core.parseDuration(sinceRaw);
    } catch (e) {
      return fail(e.message);
    }
  }

  let weeks = 8;
  if (has(args, '--weeks')) {
    weeks = parsePositiveInt(flag(args, '--weeks'));
    if (weeks === null) return fail('--weeks must be a positive integer');
  }

  let runs = store.loadRuns(owner, repo, dir);
  if (runs.length === 0) {
    if (asJson) {
      process.stdout.write(JSON.stringify({ owner, repo, total: 0 }, null, 2) + '\n');
    } else {
      process.stdout.write(dim(`no runs recorded yet for ${owner}/${repo}. Pull some with: citrend sync --repo ${owner}/${repo}\n`));
    }
    return;
  }
  if (sinceMs !== null) runs = runs.filter((r) => r.startedAtMs >= sinceMs);

  const stats = core.computeStats(runs);
  const buckets = core.bucketRuns(runs, now(), core.UNITS.w, weeks);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      owner,
      repo,
      stats,
      weeklyTrend: buckets.map((b) => ({ start: b.start, end: b.end, stats: b.stats })),
    }, null, 2) + '\n');
  } else {
    printReport(owner, repo, stats, buckets);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') { process.stdout.write(HELP); process.exit(0); }
  if (argv[0] === '-v' || argv[0] === '--version') { process.stdout.write(VERSION + '\n'); process.exit(0); }

  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'sync': return await cmdSync(rest);
      case 'report': return void cmdReport(rest);
      default: return fail(`unknown command: ${command} (try --help)`);
    }
  } catch (e) {
    fail(e.message);
  }
}

main();
