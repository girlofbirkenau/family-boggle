"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { WebSocket } = require("ws");
const { Client } = require("pg");
const { PostgresStore } = require("../postgres-store");

const root = path.join(__dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(25); }
  throw new Error("Timed out waiting for server");
}
async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function launch(t, env = {}, expectFailure = false) {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: "", GITHUB_TOKEN: "", GIST_ID: "", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (data) => { logs += data; });
  child.stderr.on("data", (data) => { logs += data; });
  const exited = once(child, "exit");
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    return exited;
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  if (!expectFailure) await until(() => {
    if (child.exitCode !== null) throw new Error(logs);
    return logs.includes("listening on port");
  });
  return { child, exited, stop, logs: () => logs, url: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}
const stats = (points) => ({ version: 1, updatedAt: points, rooms: {
  family: { players: { alice: { name: "Alice", games: 2, wins: 1, points, words: 8, bestScore: 7, mostWords: 4, longestWord: "hello", bestStreak: 1 } } },
  cousins: { players: { bob: { name: "Bob", games: 1, wins: 0, points: 3, words: 3, bestScore: 3, mostWords: 3, longestWord: "cat", bestStreak: 0 } } },
} });
const rejected = { version: 1, updatedAt: 2, words: { testword: { n: 3, first: 1, last: 2 } } };
async function seedFiles(dir, points = 12) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "stats.json"), JSON.stringify(stats(points)));
  await fs.writeFile(path.join(dir, "rejected.json"), JSON.stringify(rejected));
}

async function wordFixtures(board) {
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  const packed = html.match(/PACKED="([^"]+)"/)[1];
  const words = new Set(), prefixes = new Set();
  let previous = "";
  for (const match of packed.matchAll(/([0-9A-F])([a-z]+)/g)) {
    previous = previous.slice(0, parseInt(match[1], 16)) + match[2];
    words.add(previous);
    for (let n = 1; n <= previous.length; n++) prefixes.add(previous.slice(0, n));
  }
  function walk(i, prefix, used) {
    const word = prefix + board[i];
    if (!prefixes.has(word)) return null;
    if (word.length >= 3 && words.has(word)) return word;
    for (let j = 0; j < 16; j++) {
      if (used.has(j) || i === j || Math.abs((i >> 2) - (j >> 2)) > 1 || Math.abs((i & 3) - (j & 3)) > 1) continue;
      const found = walk(j, word, new Set([...used, i]));
      if (found) return found;
    }
    return null;
  }
  const valid = board.map((_, i) => walk(i, "", new Set())).find(Boolean);
  const snake = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12];
  const rejectedWord = snake.map((_, n) => snake.slice(0, n + 1).map((i) => board[i]).join(""))
    .find((word) => word.length >= 8 && word.length <= 16 && !words.has(word));
  assert.ok(valid);
  assert.ok(rejectedWord);
  return { valid, rejectedWord };
}

test("file-only mode still serves existing room stats and rejected words", { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "boggle-files-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await seedFiles(dir);
  const app = await launch(t, { DATA_DIR: dir });
  assert.equal((await (await fetch(app.url + "/stats.json")).json()).players[0].points, 12);
  assert.equal((await (await fetch(app.url + "/stats.json?room=cousins")).json()).players[0].name, "Bob");
  assert.equal((await (await fetch(app.url + "/rejected.json")).json()).words[0].count, 3);
  assert.equal((await app.stop())[0], 0);
});

test("configured but unreachable PostgreSQL prevents startup without exposing credentials", { timeout: 15000 }, async (t) => {
  const port = await unusedPort();
  const app = await launch(t, { DATABASE_URL: `postgresql://test:secret-do-not-log@127.0.0.1:${port}/boggle` }, true);
  assert.equal((await app.exited)[0], 1);
  assert.match(app.logs(), /PostgreSQL persistence failed/);
  assert.doesNotMatch(app.logs(), /secret-do-not-log|listening on port/);
});

test("PostgreSQL migration, round persistence, restart, and writer isolation", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 60000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const admin = new Client({ connectionString });
  await admin.connect();
  t.after(() => admin.end());
  // TEST_DATABASE_URL must point at a dedicated disposable test database.
  await admin.query("DROP TABLE IF EXISTS boggle_state");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "boggle-pg-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await seedFiles(dir);
  const env = { DATABASE_URL: connectionString, DATA_DIR: dir, BOGGLE_COUNTDOWN_MS: "20", BOGGLE_FORCE_SECONDS: "3", BOGGLE_MIN_WORDS: "1", BOGGLE_MIN_LONG: "0", BOGGLE_MIN_ER: "0" };
  const app = await launch(t, env);
  assert.equal((await (await fetch(app.url + "/stats.json")).json()).players[0].points, 12);
  assert.equal((await (await fetch(app.url + "/stats.json?room=cousins")).json()).players[0].name, "Bob");
  assert.equal((await (await fetch(app.url + "/rejected.json")).json()).words[0].count, 3);
  const competitor = new PostgresStore(connectionString);
  await assert.rejects(competitor.init(() => { throw new Error("must not import"); }), /Another Family Boggle/);
  await competitor.close();

  const ws = new WebSocket(app.ws);
  t.after(() => ws.terminate());
  const states = [];
  ws.on("message", (data) => { const msg = JSON.parse(data); if (msg.t === "state") states.push(msg); });
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "hello", key: "test-player", name: "Alice" }));
  await until(() => states.length);
  ws.send(JSON.stringify({ t: "start", duration: 1 }));
  const state = await until(() => states.find((msg) => msg.game));
  const board = state.game.board;
  const { valid, rejectedWord: candidate } = await wordFixtures(board);
  await until(() => Date.now() >= state.game.startAt);
  ws.send(JSON.stringify({ t: "words", words: [valid] }));
  ws.send(JSON.stringify({ t: "reject", word: candidate }));
  await until(() => states.find((msg) => msg.game && msg.game.results));
  assert.equal((await app.stop())[0], 0);
  const saved = (await admin.query("SELECT stats, rejected FROM boggle_state WHERE id = 1")).rows[0];
  assert.equal(saved.stats.rooms.family.players.alice.games, 3);
  assert.ok(saved.stats.rooms.family.players.alice.points > 12);
  assert.equal(saved.rejected.words[candidate].n, 1);

  // Database is authoritative even if local files are newer and Gist is down.
  await seedFiles(dir, 9999999999999);
  const restarted = await launch(t, { ...env, GITHUB_TOKEN: "unused", GITHUB_API_BASE: "http://127.0.0.1:1" });
  assert.equal((await (await fetch(restarted.url + "/stats.json")).json()).players[0].games, 3);
  assert.equal((await (await fetch(restarted.url + "/stats.json")).json()).players[0].points, saved.stats.rooms.family.players.alice.points);
  assert.equal((await (await fetch(restarted.url + "/stats.json?room=cousins")).json()).players[0].points, 3);
  // Avoid a Gist write at shutdown in this read-only authority check.
  restarted.child.kill("SIGKILL");
  await restarted.exited;

  await admin.query("DROP TABLE boggle_state");
  // A failed initial Gist read must leave no imported row and never serve games.
  const failedImport = await launch(t, { ...env, GITHUB_TOKEN: "unused", GIST_ID: "test", GITHUB_API_BASE: "http://127.0.0.1:1" }, true);
  assert.equal((await failedImport.exited)[0], 1);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM boggle_state")).rows[0].n, 0);

  // Successful first import selects the newer Gist independently for each document.
  const fixture = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ files: {
      "family-boggle-stats.json": { content: JSON.stringify(stats(99999999999999)) },
      "family-boggle-rejected.json": { content: JSON.stringify({ ...rejected, updatedAt: 99, words: { newer: { n: 8, first: 1, last: 99 } } }) },
    } }));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(() => fixture.close());
  const imported = await launch(t, { ...env, GITHUB_TOKEN: "unused", GIST_ID: "test", GITHUB_API_BASE: `http://127.0.0.1:${fixture.address().port}` });
  assert.equal((await (await fetch(imported.url + "/stats.json")).json()).players[0].points, 99999999999999);
  assert.equal((await (await fetch(imported.url + "/rejected.json")).json()).words[0].count, 8);
  assert.equal((await imported.stop())[0], 0);
});
