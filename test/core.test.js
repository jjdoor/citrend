'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDuration,
  formatDuration,
  isSettled,
  isWasted,
  computeStats,
  bucketRuns,
  normalizeRun,
  parseGithubTimestampMs,
  UNITS,
} = require('../src/core.js');

const MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = 604800000;

test('parseDuration handles all units and bare numbers', () => {
  assert.equal(parseDuration('30s'), 30000);
  assert.equal(parseDuration('5m'), 5 * MIN);
  assert.equal(parseDuration('2h'), 2 * HOUR);
  assert.equal(parseDuration('1d'), DAY);
  assert.equal(parseDuration('1w'), WEEK);
  assert.equal(parseDuration(90), 90000);
  assert.throws(() => parseDuration('soon'));
});

test('parseDuration rejects absurdly large durations instead of overflowing to Infinity', () => {
  assert.throws(() => parseDuration('1'.repeat(400) + 's'), /too large/);
  assert.throws(() => parseDuration(Number.MAX_VALUE), /too large/);
  assert.equal(parseDuration('99w'), 99 * WEEK); // sanity: a large-but-sane value still works
});

test('formatDuration is compact and two-unit max', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(90000), '1m 30s');
  assert.equal(formatDuration(DAY + 3 * HOUR), '1d 3h');
  assert.equal(formatDuration(-5), '0s');
});

test('formatDuration rounds a genuinely positive sub-second duration up to "1s", not "0s"', () => {
  assert.equal(formatDuration(999), '1s');
  assert.equal(formatDuration(1), '1s');
  assert.equal(formatDuration(500), '1s');
  assert.equal(formatDuration(1000), '1s'); // boundary: exactly one second
});

test('isSettled: null conclusion means in-progress, not settled', () => {
  assert.equal(isSettled({ conclusion: null }), false);
  assert.equal(isSettled({ conclusion: 'success' }), true);
  assert.equal(isSettled({ conclusion: 'failure' }), true);
});

test('isWasted: success and skipped are not wasted; everything else settled is', () => {
  assert.equal(isWasted({ conclusion: 'success' }), false);
  assert.equal(isWasted({ conclusion: 'skipped' }), false);
  assert.equal(isWasted({ conclusion: null }), false); // in-progress isn't wasted (yet)
  assert.equal(isWasted({ conclusion: 'failure' }), true);
  assert.equal(isWasted({ conclusion: 'cancelled' }), true);
  assert.equal(isWasted({ conclusion: 'timed_out' }), true);
  assert.equal(isWasted({ conclusion: 'some_future_value_github_adds' }), true); // fails toward visible
});

test('computeStats: basic counts and rates', () => {
  const runs = [
    { conclusion: 'success', durationMs: 1000 },
    { conclusion: 'success', durationMs: 2000 },
    { conclusion: 'failure', durationMs: 500 },
    { conclusion: 'skipped', durationMs: 0 },
    { conclusion: null, durationMs: 0 }, // in progress
  ];
  const s = computeStats(runs);
  assert.equal(s.total, 5);
  assert.equal(s.settled, 4);
  assert.equal(s.inProgress, 1);
  assert.equal(s.success, 2);
  assert.equal(s.wasted, 1);
  assert.equal(s.skipped, 1);
  // rate denominator excludes skipped: 2 success / 3 (2 success + 1 wasted) = 0.666...
  assert.equal(Math.round(s.successRate * 1000) / 1000, 0.667);
  assert.equal(Math.round(s.wastedRate * 1000) / 1000, 0.333);
  assert.equal(s.totalDurationMs, 3500);
  assert.equal(s.wastedDurationMs, 500);
});

test('computeStats: empty input gives null rates, not NaN or divide-by-zero', () => {
  const s = computeStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.successRate, null);
  assert.equal(s.wastedRate, null);
});

test('computeStats: all-skipped input gives null rates (denominator is zero)', () => {
  const s = computeStats([{ conclusion: 'skipped', durationMs: 0 }]);
  assert.equal(s.successRate, null);
  assert.equal(s.wastedRate, null);
});

test('computeStats: extremely small rates round down to exactly 0, not a tiny nonzero fraction', () => {
  // 1 success out of 200,000 settled runs -> raw rate 5e-6, well below the
  // 4-decimal rounding floor (1e-4) -> rounds to 0, not left as a fraction
  // whose scientific-notation formatting could diverge between languages.
  const runs = [{ conclusion: 'success', durationMs: 0 }];
  for (let i = 0; i < 199999; i++) runs.push({ conclusion: 'failure', durationMs: 0 });
  const s = computeStats(runs);
  assert.equal(s.successRate, 0);
});

test('computeStats: a rate right at the 1e-4 rounding floor stays decimal, not scientific notation', () => {
  // 1 success out of 10,000 settled runs -> exactly 0.0001 after rounding —
  // this is the boundary case: Python's float repr goes scientific below
  // 1e-4, so a value AT 1e-4 must render as "0.0001", not "1e-4".
  const runs = [{ conclusion: 'success', durationMs: 0 }];
  for (let i = 0; i < 9999; i++) runs.push({ conclusion: 'failure', durationMs: 0 });
  const s = computeStats(runs);
  assert.equal(s.successRate, 0.0001);
  assert.equal(String(s.successRate).includes('e'), false);
});

test('computeStats: negative/non-finite durationMs is treated as 0, not subtracted', () => {
  const s = computeStats([{ conclusion: 'success', durationMs: -500 }, { conclusion: 'success', durationMs: NaN }]);
  assert.equal(s.totalDurationMs, 0);
});

test('bucketRuns: groups by fixed-width window ending at now, oldest first', () => {
  const now = 10 * WEEK; // arbitrary epoch far enough from 0 to have full buckets
  const runs = [
    { startedAtMs: now - WEEK - 100, conclusion: 'success', durationMs: 100 }, // 2 buckets ago
    { startedAtMs: now - 100, conclusion: 'failure', durationMs: 200 }, // most recent bucket
  ];
  const buckets = bucketRuns(runs, now, WEEK, 2);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].stats.total, 1);
  assert.equal(buckets[0].stats.success, 1);
  assert.equal(buckets[1].stats.total, 1);
  assert.equal(buckets[1].stats.wasted, 1);
});

test('bucketRuns: empty buckets still appear (visible gap, not skipped)', () => {
  const now = 10 * WEEK;
  const buckets = bucketRuns([], now, WEEK, 3);
  assert.equal(buckets.length, 3);
  for (const b of buckets) assert.equal(b.stats.total, 0);
});

test('normalizeRun: computes durationMs from run_started_at to updated_at', () => {
  const raw = {
    id: 42,
    name: 'CI',
    event: 'push',
    head_branch: 'main',
    conclusion: 'success',
    run_started_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:05:00Z',
  };
  const r = normalizeRun(raw);
  assert.equal(r.id, 42);
  assert.equal(r.name, 'CI');
  assert.equal(r.branch, 'main');
  assert.equal(r.durationMs, 5 * MIN);
});

test('normalizeRun: falls back to created_at when run_started_at is absent', () => {
  const raw = {
    id: 1,
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:01:00Z',
    conclusion: null,
  };
  const r = normalizeRun(raw);
  assert.equal(r.durationMs, MIN);
  assert.equal(r.conclusion, null);
});

test('normalizeRun: missing name falls back to workflow_id, then "unknown"', () => {
  assert.equal(normalizeRun({ id: 1, workflow_id: 99, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).name, '99');
  assert.equal(normalizeRun({ id: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).name, 'unknown');
});

test('normalizeRun: never produces a negative duration', () => {
  const raw = { id: 1, run_started_at: '2026-07-01T10:05:00Z', updated_at: '2026-07-01T10:00:00Z', conclusion: 'success' };
  assert.equal(normalizeRun(raw).durationMs, 0);
});

test('UNITS exposes week for callers building custom bucket sizes', () => {
  assert.equal(UNITS.w, WEEK);
});

test('parseGithubTimestampMs: accepts exact GitHub API shape, rejects anything else', () => {
  assert.equal(parseGithubTimestampMs('2026-07-01T10:00:00Z'), Date.UTC(2026, 6, 1, 10, 0, 0));
  assert.equal(parseGithubTimestampMs(undefined), null);
  assert.equal(parseGithubTimestampMs(''), null);
  assert.equal(parseGithubTimestampMs('2026-07-01T10:00:00.123Z'), null); // fractional seconds unexpected from this API
  assert.equal(parseGithubTimestampMs('2026-07-01T10:00:00+00:00'), null); // no numeric-offset support needed here
  assert.equal(parseGithubTimestampMs('not a timestamp'), null);
});
