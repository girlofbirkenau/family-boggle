'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function section(text, start, end) {
  const i = text.indexOf(start), j = text.indexOf(end, i);
  assert.ok(i >= 0 && j > i);
  return text.slice(i, j);
}
const board = ['qu', 'e', 'e', 'n', 'a', 't', 'x', 'x', ...Array(8).fill('x')];
function setup() {
  const dictionary = new Set(['queen', 'tea', 'eat', 'qat', 'ququ', 'zoo']);
  const stats = { players: {} };
  const ctx = { stopping: false, WORDSET: dictionary, DICT: dictionary, board, stats,
    statRoom: () => stats, nameKey: n => n.toLowerCase(), saveStats() {}, broadcast() {}, broadcastRaw() {}, boardFor: () => stats };
  vm.createContext(ctx);
  vm.runInContext(section(server, 'const NB =', 'function analyze') +
    section(server, 'const ptsFor =', '/* ---------- all-time stats') +
    section(server, 'function validWordList(', 'function sanitizeWords(') +
    section(html, 'function pts(', 'const rid=') +
    section(html, 'function validWords(', 'function roundPlayers(') +
    '\nthis.basePoints = ptsFor; this.trace = traceable;', ctx);
  return ctx;
}
function player(id, words) { return { id, name: id, gid: 'round', words, ws: {} }; }

test('server and browser use linear points for every possible word length, including Qu', () => {
  const ctx = setup();
  for (let n = 3; n <= 17; n++) {
    assert.equal(ctx.basePoints(n), n - 2);
    assert.equal(ctx.pts(n), n - 2);
  }
  assert.equal(ctx.scoreWords(board, ['queen']), 3);
});

test('multiplayer doubles only unique valid words and matches browser totals', () => {
  const ctx = setup();
  const players = [player('Alice', ['queen', 'queen', 'tea', 'qat', 'ququ', 'zoo']), player('Bob', ['tea', 'eat'])];
  const totals = ctx.scoreRound(board, players);
  assert.equal(totals.get(players[0]), 7); // QUEEN doubled to 6, shared TEA remains 1.
  assert.equal(totals.get(players[1]), 3); // Shared TEA 1, unique EAT 2.
  const { scored } = ctx.scorePlayers(players);
  assert.deepEqual(Array.from(scored, p => p.total), [7, 3]);
  assert.equal(scored[0].rows.find(r => r.w === 'queen').bonus, true);
  assert.equal(scored[0].rows.find(r => r.w === 'tea').bonus, false);
});

test('solo words earn base points and an empty opponent still makes a multiplayer round', () => {
  const ctx = setup(), alice = player('Alice', ['queen', 'tea']);
  assert.equal(ctx.scoreRound(board, [alice]).get(alice), 4);
  assert.equal(ctx.scorePlayers([alice]).scored[0].total, 4);
  const bob = player('Bob', []);
  assert.equal(ctx.scoreRound(board, [alice, bob]).get(alice), 8);
  assert.deepEqual(Array.from(ctx.scorePlayers([alice, bob]).scored, p => p.total), [8, 0]);
});

test('final results, wins, and saved stats use bonus totals and exclude other rounds', () => {
  const ctx = setup();
  const alice = player('Alice', ['queen', 'tea']), bob = player('Bob', ['tea', 'eat']);
  const outsider = { ...player('Other', ['queen']), gid: 'old' };
  const game = { id: 'round', board, results: null };
  const room = { name: 'family', game, players: new Map([alice, bob, outsider].map(p => [p.id, p])) };
  ctx.finalize(room, game);
  assert.equal(ctx.stats.players.alice.points, 7);
  assert.equal(ctx.stats.players.alice.bestScore, 7);
  assert.equal(ctx.stats.players.alice.wins, 1);
  assert.equal(ctx.stats.players.bob.points, 3);
  assert.equal(ctx.stats.players.bob.wins, 0);
  assert.equal(game.results.length, 2);
  assert.equal(game.results[0].won, true);
  ctx.finalize(room, game); // Repeated finalization must not add the score twice.
  assert.equal(ctx.stats.players.alice.games, 1);
});
