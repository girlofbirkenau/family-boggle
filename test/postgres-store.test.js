"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PostgresStore } = require("../postgres-store");

function fakeStore(query, onFailure) {
  const store = new PostgresStore("postgresql://unused/unused", onFailure);
  store.client = { connect: async () => {}, end: async () => {}, query };
  return store;
}

test("existing database wins without consulting legacy storage", async () => {
  const saved = { stats: { rooms: { family: { players: {} } } }, rejected: { words: {} } };
  const store = fakeStore(async (sql) => ({ rows: sql.includes("pg_try") ? [{ acquired: true }] : sql.startsWith("SELECT stats") ? [saved] : [] }));
  assert.deepEqual(await store.init(() => { throw new Error("must not import"); }), saved);
  await store.close();
});

test("empty database imports both documents together with parameterized SQL", async () => {
  const state = { stats: { rooms: { "a'b": { players: {} } } }, rejected: { words: { example: { n: 2 } } } };
  let insert;
  const store = fakeStore(async (sql, values) => {
    if (sql.startsWith("INSERT")) insert = values;
    return { rows: sql.includes("pg_try") ? [{ acquired: true }] : [] };
  });
  assert.deepEqual(await store.init(async () => state, async () => {}), state);
  assert.deepEqual(insert.map(JSON.parse), [state.stats, state.rejected]);
  await store.close();
});

test("overlapping server cannot acquire the writer lock", async () => {
  const store = fakeStore(async () => ({ rows: [{ acquired: false }] }));
  await assert.rejects(store.init(() => {}), /Another Family Boggle/);
  await store.close();
});

test("queued writes snapshot mutable state and flush in order", async () => {
  const writes = [];
  const store = fakeStore(async (sql, values) => { writes.push(values.map(JSON.parse)); return { rowCount: 1 }; });
  const stats = { rooms: {}, updatedAt: 1 }, rejected = { words: {} };
  store.save(stats, rejected);
  stats.updatedAt = 2;
  rejected.words.hello = { n: 1 };
  store.save(stats, rejected);
  await store.close();
  assert.equal(writes[0][0].updatedAt, 1);
  assert.deepEqual(writes[0][1].words, {});
  assert.equal(writes[1][0].updatedAt, 2);
  assert.deepEqual(writes[1][1].words, { hello: { n: 1 } });
});

test("failed write is surfaced and later snapshots cannot hide it", async () => {
  const error = new Error("unavailable");
  let notified = 0, calls = 0;
  const store = fakeStore(async () => { calls++; throw error; }, () => { notified++; });
  store.save({}, {});
  store.save({}, {});
  await assert.rejects(store.flush(), error);
  assert.equal(notified, 1);
  assert.equal(calls, 1);
  await assert.rejects(store.close(), error);
});

test("a deleted state row is a persistence failure", async () => {
  const store = fakeStore(async () => ({ rowCount: 0 }));
  store.save({}, {});
  await assert.rejects(store.close(), /Missing PostgreSQL state row/);
});


test("first import refuses to insert if verified backup is missing or fails", async () => {
  let inserts = 0;
  const store = fakeStore(async sql => { if(sql.startsWith("INSERT")) inserts++; return {rows:sql.includes("pg_try")?[{acquired:true}]:[]}; });
  await assert.rejects(store.init(async()=>({stats:{rooms:{}},rejected:{words:{}}})), /backup is required/);
  await assert.rejects(store.init(async()=>({stats:{rooms:{}},rejected:{words:{}}}), async()=>{throw Error("backup disk unavailable");}), /backup disk unavailable/);
  assert.equal(inserts,0); await store.close();
});
