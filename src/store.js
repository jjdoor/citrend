'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * citrend persistence. Unlike a hand-authored file, this is a *cache* of
 * data GitHub already stores authoritatively — so it lives under the user's
 * home directory (like deadcron's ~/.deadcron), not committed to the repo
 * it's tracking. Default base: ~/.citrend, override with $CITREND_HOME.
 *
 * One JSON-Lines file per repo, namespaced `<owner>__<repo>/runs.jsonl`, so
 * tracking several repos doesn't mix their history.
 */

function baseDir() {
  return process.env.CITREND_HOME || path.join(os.homedir(), '.citrend');
}

// Slashes and other path-hostile characters can't appear in an owner/repo
// name on GitHub, but sanitize defensively anyway — this becomes a directory
// name. Dots are excluded (not just slashes) because otherwise sanitizing
// "a/../b" to "a_.._b" would still contain a ".." traversal segment; the
// on-disk cache dir name doesn't need to preserve a repo's real dots.
//
// A short SHA-256 hash of the *original* (unsanitized) string is appended so
// two distinct valid names that happen to sanitize to the same characters —
// e.g. GitHub repos "foo.bar" and "foo_bar" both collapsing to "foo_bar" —
// don't collide and silently merge their run histories. Both languages hash
// the same UTF-8 bytes the same way, so this also guarantees Node and Python
// resolve to the identical cache directory for the same owner/repo.
function sanitizeSegment(s) {
  const raw = String(s);
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
  return `${clean}-${digest}`;
}

function repoDir(owner, repo, base) {
  return path.join(base || baseDir(), `${sanitizeSegment(owner)}__${sanitizeSegment(repo)}`);
}

function runsPath(owner, repo, base) {
  return path.join(repoDir(owner, repo, base), 'runs.jsonl');
}

/**
 * Load all run records for a repo. Corrupt/blank lines — including lines
 * that are syntactically valid JSON but not an object — are skipped rather
 * than failing the whole load.
 * @returns {object[]}
 */
function loadRuns(owner, repo, base) {
  const p = runsPath(owner, repo, base);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let parsed;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
  }
  return out;
}

/**
 * Append only the runs whose `id` isn't already recorded — `sync` can be run
 * repeatedly (e.g. on a schedule) without duplicating history.
 * @param {string} owner
 * @param {string} repo
 * @param {object[]} newRuns
 * @param {string} [base]
 * @returns {number} how many were actually new and got appended
 */
function appendNewRuns(owner, repo, newRuns, base) {
  const existingIds = new Set(loadRuns(owner, repo, base).map((r) => r.id));
  const toAdd = newRuns.filter((r) => !existingIds.has(r.id));
  if (toAdd.length === 0) return 0;
  const dir = repoDir(owner, repo, base);
  fs.mkdirSync(dir, { recursive: true });
  const lines = toAdd.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(runsPath(owner, repo, base), lines);
  return toAdd.length;
}

module.exports = { baseDir, repoDir, runsPath, loadRuns, appendNewRuns };
