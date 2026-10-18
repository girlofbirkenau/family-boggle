"use strict";
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const counter = v => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
function validStats(s) {
  return object(s) && object(s.rooms) && counter(s.updatedAt) && Object.values(s.rooms).every(r =>
    object(r) && object(r.players) && Object.values(r.players).every(p =>
      object(p) && typeof p.name === "string" && ["games","wins","points","words","bestScore","mostWords","bestStreak","last","bestScoreAt"].every(k => counter(p[k])) &&
      (p.longestWord === undefined || typeof p.longestWord === "string")) &&
    (r.aliases === undefined || (object(r.aliases) && Object.values(r.aliases).every(k => typeof k === "string" && Object.hasOwn(r.players,k)))) &&
    (r.mergeHistory === undefined || Array.isArray(r.mergeHistory)));
}
function validRejected(r) {
  return object(r) && object(r.words) && counter(r.updatedAt) && Object.values(r.words).every(w =>
    object(w) && typeof w.n === "number" && counter(w.n) && counter(w.first) && counter(w.last));
}
module.exports = {validStats,validRejected};
