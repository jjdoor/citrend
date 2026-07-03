'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'citrend-test-'));
}

test('loadRuns on a missing file returns []', () => {
  const dir = tmpDir();
  assert.deepEqual(store.loadRuns('acme', 'widgets', dir), []);
});

test('appendNewRuns + loadRuns round-trip preserves order', () => {
  const dir = tmpDir();
  store.appendNewRuns('acme', 'widgets', [{ id: 1 }, { id: 2 }], dir);
  assert.deepEqual(store.loadRuns('acme', 'widgets', dir).map((r) => r.id), [1, 2]);
});

test('appendNewRuns dedupes by id — running sync twice does not duplicate history', () => {
  const dir = tmpDir();
  store.appendNewRuns('acme', 'widgets', [{ id: 1 }, { id: 2 }], dir);
  const added = store.appendNewRuns('acme', 'widgets', [{ id: 2 }, { id: 3 }], dir);
  assert.equal(added, 1); // only id:3 is new
  assert.deepEqual(store.loadRuns('acme', 'widgets', dir).map((r) => r.id), [1, 2, 3]);
});

test('loadRuns skips corrupt/blank lines and lines that are valid JSON but not an object', () => {
  const dir = tmpDir();
  const p = store.runsPath('acme', 'widgets', dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"id":1}\n\nnot json\nnull\n42\n{"id":2}\n');
  assert.deepEqual(store.loadRuns('acme', 'widgets', dir).map((r) => r.id), [1, 2]);
});

test('repoDir namespaces different repos separately, and sanitizes hostile characters', () => {
  const dir = tmpDir();
  assert.notEqual(store.repoDir('acme', 'widgets', dir), store.repoDir('acme', 'gadgets', dir));
  assert.ok(!store.repoDir('a/../b', 'c', dir).includes('..'));
});

test('repoDir does not collide for distinct names that sanitize to the same characters', () => {
  const dir = tmpDir();
  // "foo.bar" and "foo_bar" are both valid GitHub repo names and both
  // sanitize their dots/underscores to the same "foo_bar" — the hash suffix
  // must keep them apart so their run histories never get merged.
  assert.notEqual(store.repoDir('acme', 'foo.bar', dir), store.repoDir('acme', 'foo_bar', dir));
});

test('baseDir honors $CITREND_HOME override', () => {
  const prev = process.env.CITREND_HOME;
  process.env.CITREND_HOME = '/tmp/custom-citrend';
  try {
    assert.equal(store.baseDir(), '/tmp/custom-citrend');
  } finally {
    if (prev === undefined) delete process.env.CITREND_HOME;
    else process.env.CITREND_HOME = prev;
  }
});
