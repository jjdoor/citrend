'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const github = require('../src/github.js');

// Run a tiny local HTTP server standing in for api.github.com, and point
// citrend's github.js module at it via $CITREND_GITHUB_API_BASE, so we can
// inspect exactly what request path it sends without touching the real
// network.
function withMockServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      const prev = process.env.CITREND_GITHUB_API_BASE;
      process.env.CITREND_GITHUB_API_BASE = `http://127.0.0.1:${port}`;
      try {
        await fn();
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        if (prev === undefined) delete process.env.CITREND_GITHUB_API_BASE;
        else process.env.CITREND_GITHUB_API_BASE = prev;
        server.close();
      }
    });
  });
}

test('fetchWorkflowRuns percent-encodes owner/repo so a "#" cannot truncate the request path', async () => {
  let receivedPath = null;
  await withMockServer(
    (req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workflow_runs: [] }));
    },
    async () => {
      await github.fetchWorkflowRuns({ owner: 'octocat', repo: 'Hello-World#qux', limit: 5 });
    }
  );
  assert.ok(receivedPath, 'server should have received a request');
  // The literal "#" must be percent-encoded (%23) in the path the server
  // actually receives — if it weren't, URL parsing would treat everything
  // after it as a fragment and never send it to the server at all, silently
  // hitting the wrong (repo-metadata) endpoint instead of erroring.
  assert.ok(receivedPath.includes('Hello-World%23qux'), `expected percent-encoded repo in path, got: ${receivedPath}`);
  assert.ok(receivedPath.includes('/actions/runs'), `expected the runs endpoint to still be reached, got: ${receivedPath}`);
});

test('fetchWorkflowRuns paginates until batch is short or limit is reached, and truncates to limit', async () => {
  let calls = 0;
  await withMockServer(
    (req, res) => {
      calls++;
      const url = new URL(req.url, 'http://x');
      const page = Number(url.searchParams.get('page'));
      const runs = page <= 2 ? Array.from({ length: 100 }, (_, i) => ({ id: page * 1000 + i })) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workflow_runs: runs }));
    },
    async () => {
      const result = await github.fetchWorkflowRuns({ owner: 'a', repo: 'b', limit: 150 });
      assert.equal(result.length, 150); // truncated to limit even though 200 were fetched
      assert.equal(calls, 2); // stopped once limit was reached, didn't fetch page 3
    }
  );
});
