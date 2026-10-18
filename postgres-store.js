"use strict";

const { Client } = require("pg");

// Preserve the existing versioned documents so file/Gist imports and the public
// leaderboard API keep exactly the same room, name and record semantics.
class PostgresStore {
  constructor(connectionString, onFailure = () => {}) {
    this.client = new Client({
      connectionString,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
      application_name: "family-boggle",
    });
    this.onFailure = onFailure;
    this.failure = null;
    this.tail = Promise.resolve();
    this.closed = false;
    this.client.on("error", (error) => this.fail(error));
  }

  fail(error) {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.onFailure(error);
  }

  async init(legacyState, beforeImport) {
    await this.client.connect();
    // The game itself is single-process. Also prevent overlapping deployments
    // from overwriting one another's in-memory aggregate leaderboard.
    const lock = await this.client.query("SELECT pg_try_advisory_lock(1178750804, 1) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another Family Boggle server is using this database; stop it before deploying");
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS boggle_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        stats JSONB NOT NULL,
        rejected JSONB NOT NULL,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const existing = await this.client.query("SELECT stats, rejected FROM boggle_state WHERE id = 1");
    if (existing.rows.length) return existing.rows[0];
    // Only consult legacy storage for an empty database. A newer Gist or stale
    // local file must never replace an established PostgreSQL database.
    const state = await legacyState();
    if (typeof beforeImport !== "function") throw new Error("A verified backup is required before first import");
    await beforeImport(state);
    await this.client.query(
      "INSERT INTO boggle_state (id, stats, rejected) VALUES (1, $1::jsonb, $2::jsonb)",
      [JSON.stringify(state.stats), JSON.stringify(state.rejected)],
    );
    return state;
  }

  save(stats, rejected) {
    // Capture now: both objects continue changing while database I/O is pending.
    const values = [JSON.stringify(stats), JSON.stringify(rejected)];
    this.tail = this.tail.then(async () => {
      if (this.failure) return;
      const result = await this.client.query(
        "UPDATE boggle_state SET stats = $1::jsonb, rejected = $2::jsonb, saved_at = CURRENT_TIMESTAMP WHERE id = 1",
        values,
      );
      if (result.rowCount !== 1) throw new Error("Missing PostgreSQL state row");
    }).catch((error) => this.fail(error));
    return this.tail;
  }

  async flush() {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  async close() {
    try { await this.flush(); }
    finally { this.closed = true; await this.client.end(); }
  }
}

module.exports = { PostgresStore };
