"use strict";
const fs = require("fs");
const {decodeBackup} = require("../state-backup");
try {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-backup.js /path/to/backup.json");
  const {stats,rejected} = decodeBackup(fs.readFileSync(process.argv[2],"utf8"));
  const rooms=Object.values(stats.rooms);
  console.log("Backup checksum verified: " + rooms.length + " rooms, " + rooms.reduce((n,r)=>n+Object.keys(r.players).length,0) + " players, " + Object.keys(rejected.words).length + " rejected words.");
} catch(e) { console.error("Backup verification failed: " + e.message); process.exitCode=1; }
