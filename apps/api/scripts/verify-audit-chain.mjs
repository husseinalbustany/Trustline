#!/usr/bin/env node
// Checks a Trustline audit chain file (docs/specs/audit-trail.md, "The chain
// file format") on this machine alone: nothing is sent anywhere, and nothing
// of Trustline's is trusted but the public keys, which can be given apart.
//
//   node verify-audit-chain.mjs <chain.jsonl> [keys.json]
//
// keys.json: the answer of /api/v1/audit/keys ({ "keys": [...] }). Without
// it, the keys in the file's header are used. Exit code 0: every check held.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, keysFile] = process.argv.slice(2);
if (!file) {
  console.error('usage: node verify-audit-chain.mjs <chain.jsonl> [keys.json]');
  process.exit(2);
}
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const problems = [];
const fail = (message) => problems.push(message);

const header = lines[0];
if (header?.type !== 'header' || header.format !== 'trustline-audit-chain' || header.version !== 1) {
  console.error('Not a Trustline audit chain file, version 1.');
  process.exit(1);
}
const keys = new Map();
for (const k of keysFile ? JSON.parse(readFileSync(keysFile, 'utf8')).keys : header.publicKeys) {
  keys.set(k.keyId, createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' }));
}

// 1. Every entry: its body's hash, its link to the one before, its number.
const entries = lines.filter((l) => l.type === 'entry');
const bySeq = new Map();
let prev = header.previousHash;
let expected = header.firstSeq;
let withheld = 0;
for (const e of entries) {
  if (e.seq !== expected) fail(`entry ${expected}: missing (found ${e.seq})`);
  if (prev !== null && e.prevHash !== prev) fail(`entry ${e.seq}: does not link to the entry before`);
  const link = sha256(`trustline-audit-v1\n${e.seq}\n${e.prevHash}\n${e.bodyHash}`);
  if (link !== e.hash) fail(`entry ${e.seq}: its hash does not recompute`);
  if (e.body === undefined) withheld++;
  else {
    if (sha256(e.body) !== e.bodyHash) fail(`entry ${e.seq}: its body is not what was sealed`);
    if (!e.body.includes(`\nseq: ${e.seq}\n`)) fail(`entry ${e.seq}: its body names another number`);
    // While kept, the address is the one the body commits to.
    if (e.ip !== undefined) {
      const commitment = /\nip: ([0-9a-f]*)$/.exec(e.body)?.[1];
      if (sha256(`${e.ipSalt ?? ''}${e.ip}`) !== commitment) fail(`entry ${e.seq}: its address is not the one sealed`);
    }
  }
  bySeq.set(e.seq, e.hash);
  prev = e.hash;
  expected = e.seq + 1;
}
if (entries.length > 0 && entries.at(-1).seq !== header.lastSeq) fail(`the file ends at ${entries.at(-1).seq}, not ${header.lastSeq}`);

// 2. Every checkpoint: its signature under a published key, and, within
// the range, the same hash as the entry it names.
let signed = 0;
for (const cp of lines.filter((l) => l.type === 'checkpoint')) {
  const key = keys.get(cp.keyId);
  const message = `trustline-audit-checkpoint-v1\n${cp.tenant}\n${cp.seq}\n${cp.hash}\n${cp.at}`;
  if (!cp.signature) fail(`checkpoint at entry ${cp.seq}: not signed`);
  else if (!key) fail(`checkpoint at entry ${cp.seq}: signed with an unknown key (${cp.keyId})`);
  else if (!verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(cp.signature, 'base64'))) {
    fail(`checkpoint at entry ${cp.seq}: its signature does not hold`);
  } else signed++;
  if (cp.tenant !== header.tenant) fail(`checkpoint at entry ${cp.seq}: of another organization`);
  if (bySeq.has(cp.seq) && bySeq.get(cp.seq) !== cp.hash) fail(`entry ${cp.seq}: not the one its checkpoint signed`);
}

console.log(`Entries ${header.firstSeq} to ${header.lastSeq} of ${header.organization}: ${entries.length} read, ${withheld} without their body, ${signed} signed checkpoints.`);
if (problems.length > 0) {
  for (const p of problems) console.log(`FAILED: ${p}`);
  process.exit(1);
}
console.log('Every check held.');
