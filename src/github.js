'use strict';

const http = require('http');
const https = require('https');

/**
 * citrend's only network-touching module — talks to the GitHub REST API to
 * pull Actions workflow run history. Kept separate from core.js (which is
 * pure) the same way deadcron separates alert.js (side effects) from
 * core.js (pure scheduling math).
 */

const DEFAULT_API_BASE = 'https://api.github.com';

// Overridable so GitHub Enterprise Server users can point at their own API
// host, and so tests can point at a local mock server instead of the real
// network. Not a documented CLI flag (yet) — set directly for now.
function apiBase() {
  return process.env.CITREND_GITHUB_API_BASE || DEFAULT_API_BASE;
}

function request(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, apiBase());
    const lib = url.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': 'citrend-cli',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = lib.request(url, { method: 'GET', headers, timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch (e) {
          return reject(new Error(`GitHub API returned unparseable response (status ${res.statusCode})`));
        }
        const message = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.message || '' : '';
        if (res.statusCode === 403 && /rate limit/i.test(message)) {
          return reject(new Error(
            'GitHub API rate limit exceeded. Pass --token <github token> (or set $GITHUB_TOKEN) for a much higher limit.'
          ));
        }
        if (res.statusCode === 404) {
          return reject(new Error('repository or workflow not found (404) — check --repo owner/name and that it is spelled correctly and accessible with your token'));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GitHub API error ${res.statusCode}: ${message || body.slice(0, 200)}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', (e) => reject(new Error(`network error talking to GitHub API: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API request timed out')); });
    req.end();
  });
}

/**
 * Fetch recent Actions workflow runs for a repo, newest first, paginating
 * until `limit` runs are collected or GitHub runs out of pages.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} [opts.token]     GitHub token; omit for unauthenticated (60 req/hr)
 * @param {string} [opts.workflow]  workflow file name (e.g. "ci.yml") or numeric id to filter to one workflow
 * @param {string} [opts.branch]    filter to one branch
 * @param {number} [opts.limit=200] stop once this many runs have been collected
 * @returns {Promise<object[]>} raw GitHub `workflow_runs[]` elements
 */
async function fetchWorkflowRuns({ owner, repo, token, workflow, branch, limit = 200 }) {
  // Percent-encode every user-supplied path segment — an unescaped "#" in
  // owner/repo would otherwise be interpreted as a URL fragment and get
  // silently dropped from the request path (hitting the wrong endpoint,
  // e.g. repo metadata instead of workflow runs, without ever erroring).
  const ownerEnc = encodeURIComponent(owner);
  const repoEnc = encodeURIComponent(repo);
  const base = workflow
    ? `/repos/${ownerEnc}/${repoEnc}/actions/workflows/${encodeURIComponent(workflow)}/runs`
    : `/repos/${ownerEnc}/${repoEnc}/actions/runs`;
  const perPage = 100;
  const runs = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (branch) params.set('branch', branch);
    const data = await request(`${base}?${params.toString()}`, token);
    const batch = data && Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
    runs.push(...batch);
    if (batch.length < perPage || runs.length >= limit) break;
    page++;
  }
  return runs.slice(0, limit);
}

module.exports = { fetchWorkflowRuns, apiBase };
