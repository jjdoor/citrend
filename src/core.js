'use strict';

/**
 * citrend core — pure CI run aggregation logic. No fs, no clock, no network.
 * Timestamps and durations are epoch **milliseconds** to match the Python
 * implementation byte-for-byte (both read/write the same
 * ~/.citrend/<owner>__<repo>/runs.jsonl).
 *
 * A "run" record (as stored/consumed here) has the shape:
 *   { id, name, event, branch, conclusion, startedAtMs, durationMs }
 * `conclusion` is GitHub's vocabulary: 'success' | 'failure' | 'cancelled' |
 * 'skipped' | 'timed_out' | 'action_required' | 'neutral' | 'stale' |
 * 'startup_failure' | null (still in progress / not yet concluded).
 */

const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

// Generous upper bound for a parsed duration (100 years) — guards against an
// absurd/malformed --since value overflowing into Infinity/NaN territory,
// where JS and Python diverge (Math.round(Infinity) === Infinity silently,
// but Python's round(inf) raises OverflowError). Checked on the raw
// pre-rounding value so a value that already overflowed to Infinity is
// rejected before any rounding is attempted.
const MAX_DURATION_MS = 100 * 365 * UNITS.d;

/**
 * Parse a human duration like "30s", "5m", "2h", "1d", "1w" into milliseconds.
 * A bare integer means seconds. Throws on anything unrecognized or absurdly
 * large (> ~100 years).
 * @param {string|number} input
 * @returns {number}
 */
function parseDuration(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid duration: ${input}`);
    const ms = input * 1000;
    if (ms > MAX_DURATION_MS) throw new Error(`invalid duration: ${input} (too large, max ~100 years)`);
    return Math.round(ms);
  }
  const s = String(input).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/.exec(s);
  if (!m) throw new Error(`invalid duration: "${input}" (use e.g. 30s, 5m, 2h, 1d, 1w)`);
  const value = parseFloat(m[1]);
  const unit = m[2] || 's';
  const ms = value * UNITS[unit];
  if (ms > MAX_DURATION_MS) throw new Error(`invalid duration: "${input}" (too large, max ~100 years)`);
  return Math.round(ms);
}

/**
 * Format a millisecond span into a compact, two-unit-max human string. Any
 * genuinely positive duration renders as at least "1s" — a sub-second value
 * (e.g. a run that failed instantly) rounds up rather than disappearing as
 * a misleading "0s".
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const order = [['w', UNITS.w], ['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]];
  const parts = [];
  let rem = Math.round(ms);
  for (const [label, size] of order) {
    if (rem >= size) {
      const n = Math.floor(rem / size);
      rem -= n * size;
      parts.push(`${n}${label}`);
      if (parts.length === 2) break;
    } else if (parts.length > 0) {
      break;
    }
  }
  return parts.length ? parts.join(' ') : '1s';
}

/**
 * A run is "settled" once GitHub has recorded a conclusion — excludes
 * still-in-progress runs (`conclusion === null`) from rate/trend math so an
 * in-flight run doesn't get counted as a failure or skew the denominator.
 * @param {{conclusion: string|null}} run
 * @returns {boolean}
 */
function isSettled(run) {
  return run.conclusion != null;
}

/**
 * A settled run counts as "wasted" compute if it didn't succeed and wasn't
 * skipped (a skipped run never actually executed, so it didn't burn
 * compute). Everything else settled-but-not-success/skipped — failure,
 * cancelled, timed_out, action_required, stale, neutral, startup_failure,
 * or any future conclusion value GitHub adds — counts as wasted, so an
 * unrecognized value fails toward "visible" rather than silently ignored.
 * @param {{conclusion: string|null}} run
 * @returns {boolean}
 */
function isWasted(run) {
  return isSettled(run) && run.conclusion !== 'success' && run.conclusion !== 'skipped';
}

/**
 * Aggregate stats over a set of runs.
 * @param {Array<{conclusion:string|null, durationMs:number}>} runs
 * @returns {{
 *   total:number, settled:number, inProgress:number,
 *   success:number, wasted:number, skipped:number,
 *   successRate:number|null, wastedRate:number|null,
 *   totalDurationMs:number, wastedDurationMs:number,
 * }}
 */
function computeStats(runs) {
  let settled = 0, inProgress = 0, success = 0, wasted = 0, skipped = 0;
  let totalDurationMs = 0, wastedDurationMs = 0;
  for (const r of runs) {
    const dur = Number.isFinite(r.durationMs) && r.durationMs > 0 ? r.durationMs : 0;
    totalDurationMs += dur;
    if (!isSettled(r)) { inProgress++; continue; }
    settled++;
    if (r.conclusion === 'success') success++;
    else if (r.conclusion === 'skipped') skipped++;
    else { wasted++; wastedDurationMs += dur; }
  }
  const rateDenom = settled - skipped; // exclude skipped from the pass/fail rate base
  return {
    total: runs.length,
    settled,
    inProgress,
    success,
    wasted,
    skipped,
    // Rounded to 4 decimal places — not for precision (nobody needs a
    // seven-nines rate; the human display already rounds to 1 decimal
    // percent, i.e. 3 decimal places of fraction). This keeps any nonzero
    // result at or above 1e-4, which matters because Python's float repr
    // switches to scientific notation below 1e-4 while JS's doesn't until
    // 1e-6 — 4 decimals is the tighter of the two thresholds, so satisfying
    // it satisfies both languages' --json output.
    successRate: rateDenom > 0 ? Math.round((success / rateDenom) * 1e4) / 1e4 : null,
    wastedRate: rateDenom > 0 ? Math.round((wasted / rateDenom) * 1e4) / 1e4 : null,
    totalDurationMs,
    wastedDurationMs,
  };
}

/**
 * Bucket runs into fixed-size, contiguous time windows ending at `nowMs`, for
 * a trend view (most recent bucket last). Buckets with zero runs still
 * appear (with null rates) so a gap in activity is visible, not silently
 * skipped.
 *
 * @param {Array<{startedAtMs:number}>} runs
 * @param {number} nowMs
 * @param {number} bucketMs   width of each bucket, e.g. one week
 * @param {number} count      number of buckets to produce
 * @returns {Array<{start:number, end:number, stats:object}>}
 */
function bucketRuns(runs, nowMs, bucketMs, count) {
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = nowMs - i * bucketMs;
    const start = end - bucketMs;
    const inBucket = runs.filter((r) => r.startedAtMs >= start && r.startedAtMs < end);
    buckets.push({ start, end, stats: computeStats(inBucket) });
  }
  return buckets;
}

// GitHub API timestamps are always strict ISO 8601 UTC with a "Z" suffix,
// e.g. "2026-07-01T10:00:00Z" — unlike user-typed dates elsewhere in this
// product line, there's no ambiguity to accommodate, so both languages parse
// with the same narrow regex rather than trusting `Date.parse` /
// `fromisoformat`'s built-in (and mutually divergent) leniency.
const GH_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * Parse a GitHub API timestamp to epoch ms, or null if missing/malformed.
 * @param {string|undefined} value
 * @returns {number|null}
 */
function parseGithubTimestampMs(value) {
  if (!value) return null;
  const m = GH_TIMESTAMP_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/**
 * Normalize a raw GitHub Actions "workflow run" API object into the record
 * shape this module works with. Pure — takes already-parsed JSON, no
 * network. Falls back to `created_at` when `run_started_at` is absent (GitHub
 * omits it for very old runs).
 *
 * @param {object} raw  a GitHub `workflow_runs[]` element
 * @returns {{id:number, name:string, event:string, branch:string,
 *            conclusion:string|null, startedAtMs:number, durationMs:number}}
 */
function normalizeRun(raw) {
  const startedAtMs = parseGithubTimestampMs(raw.run_started_at) ?? parseGithubTimestampMs(raw.created_at);
  const updatedAtMs = parseGithubTimestampMs(raw.updated_at);
  const durationMs = startedAtMs !== null && updatedAtMs !== null
    ? Math.max(0, updatedAtMs - startedAtMs)
    : 0;
  const nameOrWorkflowId = raw.name || raw.workflow_id;
  return {
    id: raw.id,
    name: nameOrWorkflowId != null ? String(nameOrWorkflowId) : 'unknown',
    event: raw.event || 'unknown',
    branch: raw.head_branch || 'unknown',
    conclusion: raw.conclusion ?? null,
    startedAtMs: startedAtMs !== null ? startedAtMs : 0,
    durationMs,
  };
}

module.exports = {
  UNITS,
  parseDuration,
  formatDuration,
  isSettled,
  isWasted,
  computeStats,
  bucketRuns,
  normalizeRun,
  parseGithubTimestampMs,
};
