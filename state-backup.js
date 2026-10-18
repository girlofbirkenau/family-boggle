"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {validStats,validRejected} = require("./state-validation");
const digest = s => crypto.createHash("sha256").update(s).digest("hex");
function encodeBackup(state) {
  // Keep the exact serialized bytes under the checksum (JSONB may reorder keys).
  if (!validStats(state.stats) || !validRejected(state.rejected)) throw new Error("Invalid backup state");
  const payload = JSON.stringify(state);
  return JSON.stringify({format:"family-boggle-backup-v1",createdAt:new Date().toISOString(),sha256:digest(payload),payload});
}
function decodeBackup(text) {
  const bundle = JSON.parse(text);
  if (bundle.format !== "family-boggle-backup-v1" || typeof bundle.payload !== "string" || digest(bundle.payload) !== bundle.sha256) throw new Error("Backup checksum mismatch");
  const state = JSON.parse(bundle.payload);
  if (!validStats(state.stats) || !validRejected(state.rejected)) throw new Error("Invalid backup state");
  return state;
}
function writeVerifiedBackup(directory, state) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("Set BOGGLE_BACKUP_DIR to an absolute persistent backup directory before first PostgreSQL import");
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const contents = encodeBackup(state);
  const filename = path.join(directory,`pre-postgres-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.json`);
  let fd;
  try {
    fd = fs.openSync(filename,"wx",0o600);
    fs.writeFileSync(fd,contents); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
    const restored = decodeBackup(fs.readFileSync(filename,"utf8"));
    if (JSON.stringify(restored) !== JSON.stringify(state)) throw new Error("Backup verification failed");
    const dir = fs.openSync(directory,"r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return filename;
}
module.exports = {encodeBackup,decodeBackup,writeVerifiedBackup};
