"use strict";
/*
 * Family Boggle server.
 * Serves the game page and keeps one shared game per room over WebSockets.
 * Everyone who opens the same link (same ?room=) plays the same board.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { PostgresStore } = require("./postgres-store");
const { encodeBackup, writeVerifiedBackup } = require("./state-backup");
const { validStats, validRejected: validRej } = require("./state-validation");

const PORT = Number(process.env.PORT) || 3000;
// Page files normally live in ./public. If they were uploaded flat next to server.js, use those.
// The page can sit in ./public or right next to this file. If an old copy is left in one of them, use the newer build.
const SERVER_BUILD = "20261018-2";
function buildOf(dir) {
  try { const m = /name="boggle-build" content="([0-9-]+)"/.exec(fs.readFileSync(path.join(dir, "index.html"), "utf8")); return m ? m[1] : "0"; } catch (e) { return null; }
}
const PUBLIC = (() => {
  const a = path.join(__dirname, "public"), bb = buildOf(a), cb = buildOf(__dirname);
  if (bb === null) return __dirname;
  if (cb === null) return a;
  return cb > bb ? __dirname : a;
})();
const PAGE_BUILD = buildOf(PUBLIC) || "?";
console.log("Serving the page from " + PUBLIC + " (page build " + PAGE_BUILD + ", server build " + SERVER_BUILD + ")");
const COUNTDOWN_MS = Number(process.env.BOGGLE_COUNTDOWN_MS) || 3000;
const MIN_SECONDS = Number(process.env.BOGGLE_MIN_SECONDS) || 60;
const FORCE_SECONDS = Number(process.env.BOGGLE_FORCE_SECONDS) || 0; // test hook only
const GRACE_MS = 1500; // words sent just after the buzzer still count

// Classic English 4x4 Boggle: 16 six-sided dice, one roll per die.
// Q represents the single Qu face; rollBoard expands it to the two-letter tile "qu".
const DICE = ["AEANEG", "AHSPCO", "ASPFFK", "OBJOAB", "IOTMUC", "RYVDEL", "LREIXD", "EIUNES",
  "WNGEEH", "LNHNRZ", "TSTIYD", "OWTOAT", "ERTTYL", "TOESSI", "TERWHV", "NUIHMQ"];
const rnd = (n) => crypto.randomInt(n);
function rollBoard() {
  const d = DICE.slice();
  for (let i = 15; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d.map((s) => { const f = s[rnd(6)]; return f === "Q" ? "qu" : f.toLowerCase(); });
}

/* ---------- dictionary (same list the page uses to check words) ---------- */
const MIN_WORDS = process.env.BOGGLE_MIN_WORDS !== undefined ? Number(process.env.BOGGLE_MIN_WORDS) : 50;
const MIN_ER = process.env.BOGGLE_MIN_ER !== undefined ? Number(process.env.BOGGLE_MIN_ER) : 3; // "-er rich" board: this many words ending in -er (4+ letters)
// Boards that are not -er rich are still allowed some of the time (0 = never, 1 = always). 0.3 gives roughly 70% -er rich boards.
const ER_SOFT = process.env.BOGGLE_ER_SOFT !== undefined ? Number(process.env.BOGGLE_ER_SOFT) : 0.3;
const MIN_LONG = process.env.BOGGLE_MIN_LONG !== undefined ? Number(process.env.BOGGLE_MIN_LONG) : 7; // at least one word this long (0 = off)
const WORDS = [];
{
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const packed = html.match(/PACKED="([^"]+)"/)[1];
  let prev = "";
  for (const m of packed.matchAll(/([0-9A-F])([a-z]+)/g)) {
    const w = prev.slice(0, parseInt(m[1], 16)) + m[2];
    WORDS.push(w); prev = w;
  }
}
const WORDSET = new Set(WORDS);
function hasPrefix(p) {
  let lo = 0, hi = WORDS.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (WORDS[mid] < p) lo = mid + 1; else hi = mid; }
  return lo < WORDS.length && WORDS[lo].startsWith(p);
}
const NB = [];
for (let i = 0; i < 16; i++) {
  const r = i >> 2, c = i & 3, a = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 4 && cc >= 0 && cc < 4) a.push(rr * 4 + cc);
  }
  NB.push(a);
}
function analyze(b) {
  const out = new Set(), used = new Array(16).fill(false);
  let longest = 0, er = 0;
  function go(i, pre) {
    const p = pre + b[i];
    if (!hasPrefix(p)) return;
    used[i] = true;
    // A word may have several paths; count it only on its first discovery.
    if (p.length >= 3 && WORDSET.has(p) && !out.has(p)) {
      out.add(p);
      if (p.length > longest) longest = p.length;
      if (p.length >= 4 && p.endsWith("er")) er++;
    }
    for (const j of NB[i]) if (!used[j]) go(j, p);
    used[i] = false;
  }
  for (let i = 0; i < 16; i++) go(i, "");
  return { count: out.size, longest, er };
}
const countWords = (b) => analyze(b).count;
const boardOk = (b) => { const a = analyze(b); return a.count >= MIN_WORDS && a.longest >= MIN_LONG && (a.er >= MIN_ER || rnd(1000) < ER_SOFT * 1000); };
// keep rolling until the board has at least MIN_WORDS words, one MIN_LONG+ letters long, and (usually) MIN_ER words ending in -er
function newBoard() {
  let b = rollBoard();
  for (let tries = 0; tries < 5000 && !boardOk(b); tries++) b = rollBoard();
  return b;
}

/* ---------- rooms ---------- */
const rooms = new Map();
function getRoom(name) {
  let r = rooms.get(name);
  if (!r) { r = { name, game: null, players: new Map(), chat: [], touched: Date.now() }; rooms.set(name, r); }
  r.touched = Date.now();
  return r;
}
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24);
const endOf = (g) => g.startAt + g.duration * 1000;
function phaseOf(r, now = Date.now()) {
  const g = r.game;
  if (!g) return "lobby";
  if (now < g.startAt) return "count";
  if (now < endOf(g)) return "play";
  return "done";
}

function snapshotFor(r, viewer) {
  const now = Date.now();
  const g = r.game;
  const showWords = !!g && now >= endOf(g);
  const list = [];
  for (const p of r.players.values()) {
    const inRound = !!g && p.gid === g.id;
    if (!p.name) continue;
    if (!p.ws && !inRound) continue;
    list.push({
      id: p.id, name: p.name, online: !!p.ws, gid: inRound ? g.id : null,
      n: inRound ? p.words.length : 0,
      words: inRound && showWords ? p.words : undefined,
    });
  }
  return {
    t: "state", now, meId: viewer.id, game: g, players: list,
    here: [...r.players.values()].filter((q) => q.ws).length, // everyone connected, named or not
    me: { gid: viewer.gid, words: viewer.gid && g && viewer.gid === g.id ? viewer.words : [] },
  };
}
function broadcast(r) {
  for (const p of r.players.values()) {
    if (p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(snapshotFor(r, p))); } catch (e) { /* ignore */ } }
  }
}
// Base points: 3 letters -> 1, then +1 for each extra letter.
const ptsFor = (n) => Math.max(0, n - 2);
function traceable(board, word) {
  const used = new Array(16).fill(false);
  function go(i, pos) {
    const t = board[i];
    if (!word.startsWith(t, pos)) return false;
    const np = pos + t.length;
    if (np === word.length) return true;
    used[i] = true;
    for (const j of NB[i]) if (!used[j] && go(j, np)) { used[i] = false; return true; }
    used[i] = false;
    return false;
  }
  for (let i = 0; i < 16; i++) if (go(i, 0)) return true;
  return false;
}
function scoreWords(board, words, uniqueWords = new Set()) {
  let total = 0;
  for (const w of new Set(words)) if (w.length >= 3 && WORDSET.has(w) && traceable(board, w)) total += ptsFor(w.length) * (uniqueWords.has(w) ? 2 : 1);
  return total;
}
function scoreRound(board, players) {
  const valid = new Map(players.map(p => [p, validWordList(board, p.words)]));
  const counts = new Map();
  for (const words of valid.values()) for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  const unique = new Set(players.length > 1 ? [...counts].filter(([, n]) => n === 1).map(([w]) => w) : []);
  return new Map(players.map(p => [p, scoreWords(board, valid.get(p), unique)]));
}
/* ---------- all-time stats: saved to disk, backed up to a private GitHub Gist ---------- */
// On Render's free plan the disk and memory are wiped whenever the service sleeps or redeploys,
// so the stats are also copied to a secret Gist on your GitHub account (needs GITHUB_TOKEN).
// On a home server with a persistent folder the local file is enough and the Gist is just a spare copy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const GIST_NAME = "family-boggle-stats.json";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const GITHUB_API = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
const PUSH_DELAY_MS = Number(process.env.BOGGLE_BACKUP_DELAY_MS) || 15000;
let gistId = process.env.GIST_ID || "";
let stats = { version: 1, updatedAt: 0, rooms: {} };
// words players typed that were on the board but not in the word list, so the list can be improved later
const REJ_FILE = path.join(DATA_DIR, "rejected.json");
const REJ_GIST = "family-boggle-rejected.json";
const REJ_MAX = 5000;
let rejected = { version: 1, updatedAt: 0, words: {} };
let pushTimer = null, pushing = false, pushAgain = false;
const backupInfo = { enabled: !!GITHUB_TOKEN, lastOk: 0, lastError: "" };
let database = null;
// Database errors may contain connection details: log a code, never the URL.
function databaseFailed(error) {
  console.error("PostgreSQL persistence failed (" + (error.code || "database error") + "); stopping to avoid accepting unsaved games");
  process.exit(1);
}

function loadStatsFile() {
  try {
    const o = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    if (!validStats(o) && DATABASE_URL) throw new Error("Invalid legacy stats file");
    return validStats(o) ? o : null;
  } catch (e) { if (DATABASE_URL && e.code !== "ENOENT") throw e; return null; }
}
function writeStatsFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats));
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) { console.log("Could not write " + STATS_FILE + ": " + e.message); }
}
async function gh(pathPart, opts = {}) {
  const res = await fetch(GITHUB_API + pathPart, {
    ...opts,
    headers: {
      authorization: "Bearer " + GITHUB_TOKEN, accept: "application/vnd.github+json",
      "user-agent": "family-boggle", "x-github-api-version": "2022-11-28", "content-type": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("GitHub " + res.status + " on " + (opts.method || "GET") + " " + pathPart);
  return res.json();
}
async function findGist() {
  if (gistId) return gistId;
  for (let page = 1; page <= 5; page++) {
    const list = await gh("/gists?per_page=100&page=" + page);
    if (!Array.isArray(list) || !list.length) break;
    const hit = list.find((g) => g.files && g.files[GIST_NAME]);
    if (hit) { gistId = hit.id; return gistId; }
  }
  return "";
}
let rejBackup = null;
async function pullBackup() {
  if (!GITHUB_TOKEN) return null;
  try {
    const id = await findGist();
    if (!id) return null;
    const g = await gh("/gists/" + id);
    try {
      const rf = g.files && g.files[REJ_GIST];
      if (rf) {
        if (rf.truncated || typeof rf.content !== "string") throw new Error("Incomplete rejected-word backup");
        const o = JSON.parse(rf.content);
        if (!validRej(o)) throw new Error("Invalid rejected-word backup");
        rejBackup = o;
      }
    } catch (e) { if (DATABASE_URL) throw e; }
    const f = g.files && g.files[GIST_NAME];
    if (!f || f.truncated || typeof f.content !== "string") {
      if (DATABASE_URL) throw new Error("Missing or incomplete stats backup");
      return null;
    }
    const o = JSON.parse(f.content);
    if (DATABASE_URL && !validStats(o)) throw new Error("Invalid stats backup");
    return validStats(o) ? o : null;
  } catch (e) { backupInfo.lastError = String(e.message || e); console.log("Backup read failed: " + backupInfo.lastError); return null; }
}
async function pushBackup() {
  if (!GITHUB_TOKEN) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    if (database) await database.flush();
    const content = JSON.stringify(stats);
    const rcontent = JSON.stringify(rejected);
    let id = await findGist();
    if (!id) {
      const made = await gh("/gists", { method: "POST", body: JSON.stringify({ description: "Family Boggle all-time stats (backup, do not edit)", public: false, files: { [GIST_NAME]: { content }, [REJ_GIST]: { content: rcontent } } }) });
      gistId = made.id;
      console.log("Created private backup Gist " + gistId);
    } else {
      await gh("/gists/" + id, { method: "PATCH", body: JSON.stringify({ files: { [GIST_NAME]: { content }, [REJ_GIST]: { content: rcontent } } }) });
    }
    backupInfo.lastOk = Date.now(); backupInfo.lastError = "";
  } catch (e) { backupInfo.lastError = String(e.message || e); console.log("Backup write failed: " + backupInfo.lastError); }
  finally { pushing = false; if (pushAgain) { pushAgain = false; scheduleBackup(); } }
}
function scheduleBackup() { if (!GITHUB_TOKEN || pushTimer) return; pushTimer = setTimeout(() => { pushTimer = null; pushBackup(); }, PUSH_DELAY_MS); }
async function flushBackup() { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } await pushBackup(); }
function saveStats() {
  stats.updatedAt = Math.max(Date.now(), stats.updatedAt + 1);
  if (database) database.save(stats, rejected).then(() => { if (!database.failure) scheduleBackup(); });
  else { writeStatsFile(); scheduleBackup(); }
}
function writeRejFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = REJ_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rejected));
    fs.renameSync(tmp, REJ_FILE);
  } catch (e) { console.log("Could not write " + REJ_FILE + ": " + e.message); }
}
function saveRejected() {
  rejected.updatedAt = Date.now();
  if (database) database.save(stats, rejected).then(() => { if (!database.failure) scheduleBackup(); });
  else { writeRejFile(); scheduleBackup(); }
}
function handleReject(r, p, m) {
  const w = String(m.word || "").toLowerCase();
  if (!p.name || !/^[a-z]{3,16}$/.test(w) || WORDSET.has(w)) return;
  const g = r.game;
  if (!g || p.gid !== g.id || !traceable(g.board, w)) return;       // only real attempts: on the board, just not in the list
  p.rejSeen = p.rejSeen && p.rejSeen.gid === g.id ? p.rejSeen : { gid: g.id, set: new Set() };
  if (p.rejSeen.set.has(w) || p.rejSeen.set.size >= 60) return;     // count a word once per player per round
  p.rejSeen.set.add(w);
  const e = rejected.words[w];
  if (e) { e.n++; e.last = Date.now(); }
  else { if (Object.keys(rejected.words).length >= REJ_MAX) return; rejected.words[w] = { n: 1, first: Date.now(), last: Date.now() }; }
  saveRejected();
}
function rejectedList(min) {
  return Object.entries(rejected.words).filter(([w, e]) => e.n >= min).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
}
async function loadLegacyState() {
  try {
    const o = JSON.parse(fs.readFileSync(REJ_FILE, "utf8"));
    if (validRej(o)) rejected = o;
    else if (DATABASE_URL) throw new Error("Invalid legacy rejected-word file");
  } catch (e) { if (DATABASE_URL && e.code !== "ENOENT") throw e; }
  const local = loadStatsFile();
  let timeout;
  const backup = DATABASE_URL ? await pullBackup() : await Promise.race([pullBackup(), new Promise((r) => { timeout = setTimeout(() => r(null), 12000); })]);
  clearTimeout(timeout);
  // An empty database must not turn a temporary Gist outage into an empty
  // permanent import. Fix the backup connection and restart before playing.
  if (DATABASE_URL && backupInfo.lastError) throw new Error("Legacy backup could not be read; retry migration before starting");
  const best = [local, backup].filter(Boolean).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
  if (best) stats = best;
  if (!DATABASE_URL && best && best === backup) writeStatsFile();
  if (rejBackup && (rejBackup.updatedAt || 0) > (rejected.updatedAt || 0)) { rejected = rejBackup; if (!DATABASE_URL) writeRejFile(); }
  console.log("Stats loaded (" + (best === backup && backup ? "from backup" : best ? "from disk" : "new") + "), rooms: " + Object.keys(stats.rooms).length + (GITHUB_TOKEN ? ", GitHub backup on" : ", GitHub backup off (set GITHUB_TOKEN to turn on)"));
  return { stats, rejected };
}
async function initStats() {
  if (!DATABASE_URL) { await loadLegacyState(); return; }
  database = new PostgresStore(DATABASE_URL, databaseFailed);
  const state = await database.init(loadLegacyState, state => {
    const file = writeVerifiedBackup(process.env.BOGGLE_BACKUP_DIR, state);
    console.log("Verified pre-import backup saved to " + file);
  });
  if (!validStats(state.stats) || !validRej(state.rejected)) throw new Error("Invalid PostgreSQL state");
  stats = state.stats;
  rejected = state.rejected;
  console.log("Stats loaded from PostgreSQL, rooms: " + Object.keys(stats.rooms).length);
}

const nameKey = (n) => String(n || "").trim().toLowerCase().slice(0, 24);
function statRoom(name) { return (stats.rooms[name] = stats.rooms[name] || { players: {} }); }
function boardFor(name) {
  const room = stats.rooms[name];
  const players = room ? Object.values(room.players).map((p) => ({
    name: p.name, games: p.games, wins: p.wins, points: p.points, words: p.words,
    bestScore: p.bestScore, longestWord: p.longestWord || "", mostWords: p.mostWords, bestStreak: p.bestStreak,
  })) : [];
  return { players };
}
function validWordList(board, words) {
  const out = [];
  for (const w of new Set(words)) if (w.length >= 3 && WORDSET.has(w) && traceable(board, w)) out.push(w);
  return out;
}
// folds one finished round into the all-time stats; returns short "new record" messages
function recordRound(r, g, inRound, totals, winners) {
  const room = statRoom(r.name);
  const prev = { score: 0, wordLen: 0, words: 0, streak: 0 };
  for (const p of Object.values(room.players)) {
    prev.score = Math.max(prev.score, p.bestScore || 0); prev.wordLen = Math.max(prev.wordLen, (p.longestWord || "").length);
    prev.words = Math.max(prev.words, p.mostWords || 0); prev.streak = Math.max(prev.streak, p.bestStreak || 0);
  }
  const best = { score: null, wordLen: null, words: null, streak: null };
  const now = Date.now();
  for (const p of inRound) {
    const valid = validWordList(g.board, p.words);
    if (!valid.length && !p.ws) continue; // someone who left a tab open and never played does not get a game
    const originalKey = nameKey(p.name);
    const key = (room.aliases && Object.hasOwn(room.aliases, originalKey) && room.aliases[originalKey]) || originalKey;
    if (!key) continue;
    if (!room.players[key] && Object.keys(room.players).length >= 200) continue;
    const e = (room.players[key] = room.players[key] || { name: p.name, games: 0, wins: 0, points: 0, words: 0, bestScore: 0, mostWords: 0, longestWord: "", bestStreak: 0 });
    if (key === originalKey) e.name = p.name; e.games++; e.points += totals.get(p); e.words += valid.length; e.last = now;
    if (winners.has(p)) e.wins++;
    const sc = totals.get(p);
    if (sc > e.bestScore) { e.bestScore = sc; e.bestScoreAt = now; if (sc > prev.score && (!best.score || sc > best.score.v)) best.score = { n: p.name, v: sc }; }
    if (valid.length > e.mostWords) { e.mostWords = valid.length; if (valid.length > prev.words && (!best.words || valid.length > best.words.v)) best.words = { n: p.name, v: valid.length }; }
    const lw = valid.slice().sort((x, y) => y.length - x.length || (x < y ? -1 : 1))[0];
    if (lw && lw.length > (e.longestWord || "").length) { e.longestWord = lw; if (lw.length > prev.wordLen && (!best.wordLen || lw.length > best.wordLen.v.length)) best.wordLen = { n: p.name, v: lw }; }
    if ((p.streak || 0) > e.bestStreak) { e.bestStreak = p.streak; if (p.streak > prev.streak && (!best.streak || p.streak > best.streak.v)) best.streak = { n: p.name, v: p.streak }; }
  }
  saveStats();
  const msgs = [];
  if (prev.score > 0 && best.score) msgs.push(best.score.n + ": best round ever, " + best.score.v + " points");
  if (prev.wordLen > 0 && best.wordLen) msgs.push(best.wordLen.n + ": longest word ever, " + best.wordLen.v.toUpperCase());
  if (prev.words > 0 && best.words) msgs.push(best.words.n + ": most words in a round, " + best.words.v);
  if (prev.streak > 0 && best.streak) msgs.push(best.streak.n + ": longest win streak, " + best.streak.v);
  return msgs;
}

function finalize(r, g) {
  if (stopping || r.game !== g || g.results) return;
  const inRound = [...r.players.values()].filter((p) => p.gid === g.id);
  const totals = scoreRound(g.board, inRound);
  const top = Math.max(0, ...totals.values());
  // a winner needs at least one opponent and at least one point; a tie crowns everyone tied
  const winners = new Set(inRound.length > 1 && top > 0 ? inRound.filter((p) => totals.get(p) === top) : []);
  if (winners.size) for (const p of inRound) p.streak = winners.has(p) ? (p.streak || 0) + 1 : 0;
  g.results = inRound.map((p) => ({ id: p.id, name: p.name || "Player", words: p.words.slice(), streak: p.streak || 0, won: winners.has(p) }));
  try { g.records = recordRound(r, g, inRound, totals, winners); } catch (e) { console.log("Stats error: " + e.message); g.records = []; }
  broadcast(r);
  broadcastRaw(r, { t: "stats", stats: boardFor(r.name) });
}

function sanitizeWords(arr) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(arr)) return out;
  for (const w of arr) {
    if (typeof w !== "string" || !/^[a-z]{3,16}$/.test(w) || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= 400) break;
  }
  return out;
}

/* ---------- chat ---------- */
const CHAT_KEEP = 100;      // messages remembered per room
const CHAT_MAX_LEN = 200;
function cleanChat(s) { return String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_LEN); }
function sendRaw(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } } }
function broadcastRaw(r, obj) { for (const p of r.players.values()) sendRaw(p.ws, obj); }
/* Voice media travels over WebRTC; this server only relays room-local signaling. */
const VOICE_LIMIT = 8;
const ICE_SERVERS = (() => {
  const fallback = [{ urls: "stun:stun.l.google.com:19302" }];
  if (!process.env.VOICE_ICE_SERVERS) return fallback;
  const servers = JSON.parse(process.env.VOICE_ICE_SERVERS);
  if (!Array.isArray(servers) || !servers.length || servers.some(s => !s ||
    !(typeof s.urls === "string" || (Array.isArray(s.urls) && s.urls.length && s.urls.every(u => typeof u === "string"))))) {
    throw new Error("VOICE_ICE_SERVERS must be a non-empty JSON array of RTCIceServer objects");
  }
  return servers;
})();
const TURN_URLS = (process.env.VOICE_TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
if (TURN_URLS.length && !process.env.VOICE_TURN_SECRET) throw new Error("VOICE_TURN_URLS requires VOICE_TURN_SECRET");
function voiceIceFor(p) {
  if (!TURN_URLS.length) return ICE_SERVERS;
  // coturn's shared-secret authentication: clients get expiring credentials, never the secret.
  const username = Math.floor(Date.now() / 1000 + 86400) + ":" + p.id;
  const credential = crypto.createHmac("sha1", process.env.VOICE_TURN_SECRET).update(username).digest("base64");
  return [...ICE_SERVERS, { urls: TURN_URLS, username, credential }];
}
function voiceRoster(r) {
  return [...r.players.values()].filter(p => p.ws && p.voice).map(p => ({
    id: p.id, name: p.name, muted: p.voiceMuted, session: p.voice,
  }));
}
function broadcastVoice(r) { broadcastRaw(r, { t: "voice-roster", peers: voiceRoster(r) }); }
function leaveVoice(r, p) {
  if (!p.voice) return;
  p.voice = null; p.voiceMuted = true;
  broadcastVoice(r);
}
function handleVoice(r, p, m) {
  if (m.t === "voice-join") {
    if (!p.name) { sendRaw(p.ws, { t: "voice-error", message: "Enter your name before joining voice." }); return; }
    if (!p.voice && voiceRoster(r).length >= VOICE_LIMIT) {
      sendRaw(p.ws, { t: "voice-error", message: "Voice is full (8 people)." }); return;
    }
    p.voice = p.voice || crypto.randomBytes(8).toString("hex");
    p.voiceMuted = !!m.muted;
    sendRaw(p.ws, { t: "voice-ready", iceServers: voiceIceFor(p), session: p.voice });
    broadcastVoice(r); return;
  }
  if (m.t === "voice-leave") { leaveVoice(r, p); return; }
  if (!p.voice) return;
  if (m.t === "voice-mute") { p.voiceMuted = !!m.muted; broadcastVoice(r); return; }
  if (m.t !== "voice-signal" || m.session !== p.voice) return;
  const target = [...r.players.values()].find(q => q.id === m.to && q.id !== p.id && q.ws && q.voice && q.voice === m.toSession);
  if (!target) return;
  const d = m.description, c = m.candidate;
  let signal;
  if (d && ["offer", "answer"].includes(d.type) && typeof d.sdp === "string" && d.sdp.length <= 16000) {
    signal = { description: { type: d.type, sdp: d.sdp } };
  } else if (c && typeof c.candidate === "string" && c.candidate.length <= 2048) {
    signal = { candidate: { candidate: c.candidate, sdpMid: typeof c.sdpMid === "string" ? c.sdpMid.slice(0, 256) : null,
      sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
      usernameFragment: typeof c.usernameFragment === "string" ? c.usernameFragment.slice(0, 256) : undefined } };
  } else return;
  const now = Date.now();
  p.voiceSignals = (p.voiceSignals || []).filter(t => now - t < 10000);
  if (p.voiceSignals.length >= 300) return;
  p.voiceSignals.push(now);
  sendRaw(target.ws, { t: "voice-signal", from: p.id, session: p.voice, toSession: target.voice, ...signal });
}
function handleChat(r, p, m) {
  if (!p.name) return;
  const text = cleanChat(m.text);
  if (!text) return;
  const now = Date.now();
  p.chatTimes = (p.chatTimes || []).filter((t) => now - t < 8000);
  if (p.chatTimes.length >= 6) return;          // at most 6 messages per 8 seconds each
  p.chatTimes.push(now);
  const msg = { id: crypto.randomBytes(4).toString("hex"), pid: p.id, name: p.name, text, at: now };
  r.chat.push(msg);
  if (r.chat.length > CHAT_KEEP) r.chat.splice(0, r.chat.length - CHAT_KEEP);
  broadcastRaw(r, { t: "chat", msg });
}

const REACTIONS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F973}", "\u{1F62E}", "\u{1F44F}", "\u{1F622}", "\u{1F525}"];
function handleReact(r, p, m) {
  if (!p.name || !REACTIONS.includes(m.emoji)) return;
  const msg = r.chat.find((x) => x.id === m.id);
  if (!msg) return;
  const now = Date.now();
  p.reactTimes = (p.reactTimes || []).filter((t) => now - t < 5000);
  if (p.reactTimes.length >= 10) return;
  p.reactTimes.push(now);
  msg.rx = msg.rx || {};
  const arr = msg.rx[m.emoji] || (msg.rx[m.emoji] = []);
  const i = arr.indexOf(p.id);
  if (i >= 0) arr.splice(i, 1); else arr.push(p.id);
  if (!arr.length) delete msg.rx[m.emoji];
  broadcastRaw(r, { t: "react", id: msg.id, rx: msg.rx });
}

const FX_KEYS = ["clap", "gg", "shock", "angry", "nerd", "party", "skull", "sob", "cat", "dog", "joe"];
// a reaction to one player's round results; each person has one reaction per other player at a time (change it or tap it again to remove it)
function handleBurst(r, p, m) {
  const g = r.game;
  if (!p.name || !g || !g.results || !FX_KEYS.includes(m.key)) return;
  const target = g.results.find((x) => x.id === m.to);
  if (!target) return;
  g.fx = g.fx || [];
  const now = Date.now();
  p.fxTimes = (p.fxTimes || []).filter((t) => now - t < 5000);
  if (p.fxTimes.length >= 8) return;                  // guards against a stuck or scripted client
  p.fxTimes.push(now);
  const i = g.fx.findIndex((x) => x.fromId === p.id && x.toId === target.id);
  if (i >= 0 && g.fx[i].key === m.key) { g.fx.splice(i, 1); broadcast(r); return; }   // same emoji again takes it back
  if (i >= 0) g.fx[i] = { from: p.name, fromId: p.id, toId: target.id, key: m.key };  // a different emoji replaces yours
  else { if (g.fx.length >= 200) return; g.fx.push({ from: p.name, fromId: p.id, toId: target.id, key: m.key }); }
  broadcast(r);
  broadcastRaw(r, { t: "burst", key: m.key, from: p.name, fromId: p.id, toId: target.id });
}

function handle(r, ws, m) {
  if (stopping) return;
  if (m.t === "ping") { sendRaw(ws, { t: "pong" }); return; } // lets a phone check that its connection is really alive
  if (m.t === "hello") {
    const key = String(m.key || "").slice(0, 64);
    if (!key) return;
    let p = r.players.get(key);
    if (!p) { p = { id: crypto.randomBytes(5).toString("hex"), key, name: "", ws: null, gid: null, words: [] }; r.players.set(key, p); }
    if (p.ws && p.ws !== ws) { leaveVoice(r, p); try { p.ws.close(); } catch (e) { /* ignore */ } }
    p.ws = ws; ws.player = p;
    p.name = cleanName(m.name) || p.name;
    const ph = phaseOf(r);
    if (r.game && (ph === "count" || ph === "play") && p.gid !== r.game.id) { p.gid = r.game.id; p.words = []; }
    broadcast(r);
    sendRaw(ws, { t: "chatlog", msgs: r.chat });
    sendRaw(ws, { t: "stats", stats: boardFor(r.name) });
    sendRaw(ws, { t: "voice-roster", peers: voiceRoster(r) });
    return;
  }
  const p = ws.player;
  if (!p || p.ws !== ws) return;
  if (typeof m.t === "string" && m.t.startsWith("voice-")) { handleVoice(r, p, m); return; }
  if (m.t === "chat") { handleChat(r, p, m); return; }
  if (m.t === "react") { handleReact(r, p, m); return; }
  if (m.t === "burst") { handleBurst(r, p, m); return; }
  if (m.t === "reject") { handleReject(r, p, m); return; }
  if (m.t === "name") { p.name = cleanName(m.name) || p.name; broadcast(r); if (p.voice) broadcastVoice(r); return; }
  if (m.t === "start") {
    const ph = phaseOf(r);
    if (ph !== "lobby" && ph !== "done") return;
    if (!p.name) return;
    const duration = FORCE_SECONDS || Math.max(MIN_SECONDS, Math.min(600, Math.round(Number(m.duration)) || 90));
    const shared = "count"; // shared words always score for everyone
    const now = Date.now();
    const g = {
      id: crypto.randomBytes(5).toString("hex"), board: newBoard(), createdAt: now,
      startAt: now + COUNTDOWN_MS, duration, shared, hostName: p.name, results: null,
    };
    r.game = g;
    for (const q of r.players.values()) { q.gid = q.ws ? g.id : null; q.words = []; }
    broadcast(r);
    setTimeout(() => finalize(r, g), endOf(g) + GRACE_MS + 50 - now);
    return;
  }
  if (m.t === "words") {
    const g = r.game;
    const now = Date.now();
    if (!g || p.gid !== g.id || now < g.startAt || now > endOf(g) + GRACE_MS) return;
    const incoming = sanitizeWords(m.words);
    const merged = incoming.slice();
    for (const w of p.words) if (!merged.includes(w)) merged.push(w);
    p.words = merged.slice(0, 400);
    broadcast(r);
  }
}

/* ---------- http ---------- */
const files = {};
function load(name, type) {
  const buf = fs.readFileSync(path.join(PUBLIC, name));
  files["/" + name] = { type, buf, gz: zlib.gzipSync(buf, { level: 9 }) };
}
load("index.html", "text/html; charset=utf-8");
load("manifest.webmanifest", "application/manifest+json");
load("icon.png", "image/png");
load("admin.html", "text/html; charset=utf-8");
load("admin.js", "text/javascript; charset=utf-8");
load("voice.js", "text/javascript; charset=utf-8");
load("sudoku.html", "text/html; charset=utf-8");
load("sudoku.css", "text/css; charset=utf-8");
load("sudoku-engine.js", "text/javascript; charset=utf-8");
load("sudoku.js", "text/javascript; charset=utf-8");
files["/"] = files["/index.html"];


// Admin credentials are sent only in an Authorization header and never stored by the page.
const ADMIN_PASSWORD = process.env.BOGGLE_ADMIN_PASSWORD || "";
let adminWritePending = false;
const adminDigest = s => crypto.createHash("sha256").update(s).digest();
async function handleAdmin(req, res, url) {
  const reply = (code, body) => { res.writeHead(code, {"content-type":"application/json", "cache-control":"no-store", "x-content-type-options":"nosniff"}); res.end(JSON.stringify(body)); };
  if (!ADMIN_PASSWORD) return reply(503, {error:"Set BOGGLE_ADMIN_PASSWORD on the server to enable admin access."});
  const supplied = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!crypto.timingSafeEqual(adminDigest(supplied), adminDigest(ADMIN_PASSWORD))) return reply(401, {error:"Incorrect admin password."});
  if (stopping) return reply(503,{error:"Server is stopping. Try again after restart."});
  if (url.pathname === "/api/admin/backup" && req.method === "GET") {
    try {
      if (database) await database.flush();
      const backup = encodeBackup({stats,rejected});
      res.writeHead(200,{"content-type":"application/json", "cache-control":"no-store", "content-disposition":'attachment; filename="family-boggle-backup-'+Date.now()+'.json"', "x-content-type-options":"nosniff"});
      res.end(backup); return;
    } catch(e) { return reply(503,{error:"Backup could not be created."}); }
  }
  if (url.pathname === "/api/admin/players" && req.method === "GET") {
    return reply(200, {updatedAt:stats.updatedAt, rooms:Object.entries(stats.rooms).map(([name, room]) => ({name, players:Object.entries(room.players).map(([key, p]) => ({...p,key}))}))});
  }
  if (url.pathname !== "/api/admin/merge" || req.method !== "POST") return reply(404, {error:"Not found."});
  try {
    let body = "";
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return reply(413, {error:"Request too large."}); }
    if (adminWritePending) return reply(409,{error:"Another merge is being saved. Refresh and try again."});
    const m = JSON.parse(body), room = Object.hasOwn(stats.rooms,m.room) ? stats.rooms[m.room] : null;
    if (!room || typeof m.source !== "string" || typeof m.target !== "string" || m.source === m.target || !Object.hasOwn(room.players,m.source) || !Object.hasOwn(room.players,m.target)) return reply(400,{error:"Select two different existing players in the same room."});
    if (m.updatedAt !== stats.updatedAt) return reply(409,{error:"Stats changed. Refresh and review the preview again."});
    const live = rooms.get(m.room);
    if (live && live.game && !live.game.results && phaseOf(live) === "done") { finalize(live, live.game); return reply(409,{error:"Round results were saved. Refresh and review the preview again."}); }
    if (live && ["count","play"].includes(phaseOf(live))) return reply(409,{error:"Wait for the current round to finish before merging."});
    const next = JSON.parse(JSON.stringify(stats)), r = next.rooms[m.room];
    const a = r.players[m.source], b = r.players[m.target];
    r.mergeHistory = r.mergeHistory || [];
    r.mergeHistory.push({at:Date.now(),sourceKey:m.source,targetKey:m.target,source:{...a},target:{...b},aliases:{...r.aliases}});
    for (const field of ["games","wins","points","words"]) b[field] = (Number(a[field])||0)+(Number(b[field])||0);
    if ((a.bestScore||0) > (b.bestScore||0)) { b.bestScore=a.bestScore; b.bestScoreAt=a.bestScoreAt; }
    for (const field of ["mostWords","bestStreak","last"]) b[field]=Math.max(a[field]||0,b[field]||0);
    if ((a.longestWord||"").length > (b.longestWord||"").length) b.longestWord=a.longestWord;
    delete r.players[m.source];
    r.aliases = r.aliases || {};
    for (const key of Object.keys(r.aliases)) if (r.aliases[key] === m.source) r.aliases[key]=m.target;
    r.aliases[m.source]=m.target;
    next.updatedAt=Math.max(Date.now(),stats.updatedAt+1);
    // A successful response requires a saved snapshot in the authoritative store.
    if (database) {
      // Queue the snapshot and publish the new identity mapping synchronously, so
      // rounds in other rooms cannot overwrite it while database I/O is pending.
      adminWritePending = true;
      const saved = database.save(next,rejected);
      stats = next;
      try { await saved; if (database.failure) throw database.failure; }
      finally { adminWritePending = false; }
    } else {
      fs.mkdirSync(DATA_DIR,{recursive:true});
      fs.writeFileSync(STATS_FILE+".tmp",JSON.stringify(next));
      fs.renameSync(STATS_FILE+".tmp",STATS_FILE);
      stats = next;
    }
    scheduleBackup();
    if (live) broadcastRaw(live,{t:"stats",stats:boardFor(m.room)});
    return reply(200,{ok:true,name:b.name});
  } catch(e) { return reply(400,{error:e instanceof SyntaxError ? "Invalid request." : "Merge could not be saved. Original records were kept."}); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/admin/")) { await handleAdmin(req, res, url); return; }
  if (url.pathname === "/admin") url.pathname = "/admin.html";
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  if (url.pathname === "/stats.json") {
    const room = (url.searchParams.get("room") || "family").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "family";
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ room, ...boardFor(room), backup: { enabled: backupInfo.enabled, lastOk: backupInfo.lastOk || null, lastError: backupInfo.lastError || null } }));
    return;
  }
  if (url.pathname === "/version") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ server: SERVER_BUILD, page: PAGE_BUILD, servedFrom: PUBLIC === __dirname ? "next to server.js" : "public folder" }));
    return;
  }
  if (url.pathname === "/rejected.txt" || url.pathname === "/rejected.json") {
    const min = Math.max(1, Number(url.searchParams.get("min")) || 1);
    const list = rejectedList(min);
    if (url.pathname === "/rejected.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ total: list.length, words: list.map(([word, e]) => ({ word, count: e.n, last: new Date(e.last).toISOString() })) }));
    } else {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(list.length ? list.map(([w, e]) => w + " " + e.n).join("\n") + "\n" : "(no rejected words yet)\n");
    }
    return;
  }
  const f = files[url.pathname];
  if (!f) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
  const headers = { "content-type": f.type, "cache-control": f.type.startsWith("image") ? "public, max-age=86400" : "no-cache" };
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "") && !f.type.startsWith("image")) {
    headers["content-encoding"] = "gzip"; headers["content-length"] = f.gz.length;
    res.writeHead(200, headers); res.end(f.gz);
  } else { headers["content-length"] = f.buf.length; res.writeHead(200, headers); res.end(f.buf); }
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 20000 });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const name = (url.searchParams.get("room") || "family").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "family";
  const r = getRoom(name);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    r.touched = Date.now();
    handle(r, ws, m);
  });
  ws.on("close", () => {
    const p = ws.player;
    if (p && p.ws === ws) { p.ws = null; leaveVoice(r, p); broadcast(r); }
  });
  ws.on("error", () => {});
});

// keep connections alive (and detect dropped ones, such as phones on hospital Wi-Fi)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 25000);
// forget rooms nobody has touched for a day
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [k, r] of rooms) if (r.touched < cutoff && ![...r.players.values()].some((p) => p.ws)) rooms.delete(k);
}, 3600 * 1000);

initStats().then(() => {
  server.listen(PORT, () => console.log("Family Boggle listening on port " + PORT));
}).catch((e) => {
  // Never start an apparently empty server when configured persistence fails.
  if (DATABASE_URL) databaseFailed(e);
  console.error("Stats init failed: " + e.message);
  process.exit(1);
});
// Render (and Docker) send SIGTERM before stopping: save everything first
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  if (stopping) return; stopping = true;
  server.close();
  for (const ws of wss.clients) ws.terminate();
  async function finish() {
    if (database) await database.close();
    else { writeStatsFile(); writeRejFile(); }
    await flushBackup();
  }
  const deadline = setTimeout(() => { console.error("Persistence shutdown timed out"); process.exit(1); }, 15000);
  finish().then(() => { clearTimeout(deadline); process.exit(0); }, () => { clearTimeout(deadline); process.exit(1); });
});
