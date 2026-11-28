#!/usr/bin/env node
// Checks a Trustline audit chain file (docs/specs/audit-trail.md, "The chain
// file format") on this machine alone: nothing is sent anywhere, and nothing
// in the file is trusted, its keys included.
//
//   node verify-audit-chain.mjs <chain.jsonl> <keys.json> [--allow-unanchored-tail]
//
// keys.json: the answer of /api/v1/audit/keys ({ "keys": [...] }), taken from
// Trustline's site, not from whoever hands over the file. Exit code 0: every
// check held, and a signed checkpoint covers the last entry (or, with the
// flag, some entry of the file: the entries after it are then unanchored).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [file, keysFile, flag] = process.argv.slice(2);
if (!file || !keysFile) {
  console.error('usage: node verify-audit-chain.mjs <chain.jsonl> <keys.json> [--allow-unanchored-tail]');
  console.error('The published keys are required: keys inside the file prove nothing.');
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
for (const k of JSON.parse(readFileSync(keysFile, 'utf8')).keys) {
  keys.set(k.keyId, createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' }));
}

// 1. Every entry: the number, the link, and, where the body is given, its
// hash, the link hash, and that it names this entry of this organization.
// A withheld entry (no body, no body hash) is checked by its links only.
const entries = lines.filter((l) => l.type === 'entry');
if (entries.length !== header.lastSeq - header.firstSeq + 1) {
  fail(`the file holds ${entries.length} entries, not ${header.lastSeq - header.firstSeq + 1}`);
}
const bySeq = new Map();
let prev = header.previousHash;
let expected = header.firstSeq;
let withheld = 0;
for (const e of entries) {
  if (e.seq !== expected) fail(`entry ${expected}: missing (found ${e.seq})`);
  if (e.prevHash !== prev) fail(`entry ${e.seq}: does not link to the entry before`);
  if (e.bodyHash === undefined) withheld++;
  else {
    if (sha256(`trustline-audit-v1\n${e.seq}\n${e.prevHash}\n${e.bodyHash}`) !== e.hash) fail(`entry ${e.seq}: its hash does not recompute`);
    if (typeof e.body !== 'string' || sha256(e.body) !== e.bodyHash) fail(`entry ${e.seq}: its body is not what was sealed`);
    const field = (name) => new RegExp(`\\n${name}: ([^\\n]*)`).exec(e.body ?? '')?.[1];
    if (field('id') !== e.entryId) fail(`entry ${e.seq}: its body is of another entry`);
    if (field('tenant') !== header.tenant) fail(`entry ${e.seq}: its body is of another organization`);
    if (field('seq') !== String(e.seq)) fail(`entry ${e.seq}: its body names another number`);
    if (e.ip !== undefined && sha256(`${e.ipSalt ?? ''}${e.ip}`) !== field('ip')) fail(`entry ${e.seq}: its address is not the one sealed`);
  }
  bySeq.set(e.seq, e.hash);
  prev = e.hash;
  expected = e.seq + 1;
}

// 2. The checkpoints: each signed under a published key, of this
// organization, and naming the same hash as the entry at its number.
let anchored = 0;
for (const cp of lines.filter((l) => l.type === 'checkpoint')) {
  const key = keys.get(cp.keyId);
  const message = `trustline-audit-checkpoint-v1\n${cp.tenant}\n${cp.seq}\n${cp.hash}\n${cp.at}`;
  if (cp.tenant !== header.tenant) fail(`checkpoint at entry ${cp.seq}: of another organization`);
  else if (!cp.signature || !key) fail(`checkpoint at entry ${cp.seq}: not signed with a published key`);
  else if (!verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(cp.signature, 'base64'))) {
    fail(`checkpoint at entry ${cp.seq}: its signature does not hold`);
  } else if (bySeq.has(cp.seq)) {
    if (bySeq.get(cp.seq) !== cp.hash) fail(`entry ${cp.seq}: not the one its checkpoint signed`);
    else anchored = Math.max(anchored, cp.seq);
  }
}
if (anchored === 0) fail('no signed checkpoint covers any entry of the file');
else if (anchored < header.lastSeq) {
  const note = `entries ${anchored + 1} to ${header.lastSeq} come after the last signed checkpoint`;
  if (flag === '--allow-unanchored-tail') console.log(`NOTE: ${note}: not anchored.`);
  else fail(note);
}

console.log(`Entries ${header.firstSeq} to ${header.lastSeq} of ${header.organization}: ${entries.length} read, ${withheld} by their links only, anchored up to ${anchored}.`);
if (problems.length > 0) {
  for (const p of problems) console.log(`FAILED: ${p}`);
  process.exit(1);
}
console.log('Every check held.');
