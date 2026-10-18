'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {encodeBackup,decodeBackup,writeVerifiedBackup}=require('../state-backup');
const state={stats:{version:1,rooms:{family:{players:{bob:{name:'Bob',points:42}},aliases:{bobby:'bob'},mergeHistory:[{source:{points:10},target:{points:32}}]}}},rejected:{version:1,words:{example:{n:2}}}};
test('full backup restores all rooms, aliases, merge history and rejected words and detects corruption',()=>{
 const encoded=encodeBackup(state);assert.deepEqual(decodeBackup(encoded),state);
 const corrupt=JSON.parse(encoded);corrupt.payload=corrupt.payload.replace('42','43');assert.throws(()=>decodeBackup(JSON.stringify(corrupt)),/checksum/);
});
test('pre-import backup is verified from disk and refuses an unset or unwritable directory',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boggle-backup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 assert.throws(()=>writeVerifiedBackup('',state),/BOGGLE_BACKUP_DIR/);
 assert.throws(()=>writeVerifiedBackup('relative',state),/BOGGLE_BACKUP_DIR/);
 const file=writeVerifiedBackup(dir,state);assert.deepEqual(decodeBackup(fs.readFileSync(file,'utf8')),state);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.throws(()=>writeVerifiedBackup(file,state));
});

test('malformed room data and dangling aliases cannot become migration backups',()=>{
 assert.throws(()=>encodeBackup({stats:{rooms:{family:{}}},rejected:{words:{}}}),/Invalid backup/);
 const broken=JSON.parse(JSON.stringify(state));broken.stats.rooms.family.aliases.bobby='missing';assert.throws(()=>encodeBackup(broken),/Invalid backup/);
 const invalidCounter=JSON.parse(JSON.stringify(state));invalidCounter.stats.rooms.family.players.bob.points=-1;assert.throws(()=>encodeBackup(invalidCounter),/Invalid backup/);
});
