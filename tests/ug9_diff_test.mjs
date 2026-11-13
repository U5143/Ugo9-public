// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// Two .ug9 side by side (tools/ug9_diff.mjs, 機能の比べ #94): the same file is the same; a copy of the sample with
// known edits shows exactly those (the tables that grew or shrank, the names added and removed, and the fields of the
// ones that changed); a working JSON is compiled first; the command line answers 0 or 1.
//   node tests/ug9_diff_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ug9Diff, formatDiff } from '../tools/ug9_diff.mjs';
import { compileUgo } from '../tools/compile.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const ug9 = fs.readFileSync('samples/basic/model.ug9'), json = JSON.parse(fs.readFileSync('samples/basic/model.json', 'utf8'));

const same = ug9Diff(ug9, ug9);
check(same.same && !Object.keys(same.names).length && !same.rest.length, 'the same file is the same (nothing listed)');
check(ug9Diff(ug9, json).same, 'the working JSON compiled is the same as its .ug9');

// known edits
const m = structuredClone(json);
m.animations.splice(1, 1);
const neck = m.parts.find((p) => p.id === 'neck'), face = m.parts.find((p) => p.id === 'face'), head = m.bones.find((b) => b.id === 'head');
neck.vertices[0] += 5; neck.vertices[3] -= 2;
face.opacity = 0.5;
head.rotation = (head.rotation || 0) + 10;
m.parameters.push({ id: 'New', min: 0, max: 1, default: 0 });
m.animations[0].duration += 1;
const after = new Uint8Array(compileUgo(m));
const d = ug9Diff(ug9, after), N = d.names;
check(!d.same, 'the edited copy differs');
const nc = N.parts?.changed.find((c) => c.id === 'neck')?.fields;
check(N.parts?.changed.length === 2 && nc?.length === 1 && nc[0].field === 'vertices' && nc[0].changed === 2 && Math.abs(nc[0].most - 5) < 1e-3
  && N.parts.changed.find((c) => c.id === 'face')?.fields.map((f) => `${f.field}:${f.before}→${f.after}`).join() === 'opacity:1→0.5',
  `parts: neck's vertices (2 numbers changed, at most 5) and face's opacity 1 → 0.5, nothing else (${N.parts?.changed.map((c) => c.id).join(', ')})`);
check(N.bones?.changed.length === 1 && N.bones.changed[0].id === 'head' && N.bones.changed[0].fields[0].field === 'rotation' && Math.abs(N.bones.changed[0].fields[0].after - N.bones.changed[0].fields[0].before - 10) < 1e-3,
  'bones: head\'s rotation +10°');
check(N.parameters?.added.join() === 'New' && !N.parameters.removed.length && !N.parameters.changed.length, 'parameters: New added');
check(N.animations?.removed.join() === 'talk' && N.animations.changed.length === 1 && N.animations.changed[0].fields[0].field === 'duration',
  'animations: talk removed, idle\'s duration changed');
const t = Object.fromEntries(d.tables.map((x) => [x.name, x]));
check(t.parameters.count.join() === '14,15' && t.animations.count.join() === '2,1' && t.parameters.bytes[1] - t.parameters.bytes[0] === 16
  && d.tables.filter((x) => x.count[0] !== x.count[1]).every((x) => ['parameters', 'animations', 'tracks', 'keys', 'strings'].includes(x.name)),
  `tables: records and bytes before and after; only those the edits touch differ (${d.tables.filter((x) => x.count[0] !== x.count[1]).map((x) => x.name).join(', ')})`);
check(!N.physics && !N.chains && !d.rest.length, 'what was not edited is not listed');
const text = formatDiff(d);
check(/neck: vertices \(\d+ numbers, 2 changed, at most 5\)/.test(text) && text.includes('face: opacity 1 → 0.5') && text.includes('removed: talk') && text.includes('added: New'),
  'the text says it in a line each');

// the drawing order of parts changed, nothing else
const r = structuredClone(json);
[r.parts[1], r.parts[2]] = [r.parts[2], r.parts[1]];
const dr = ug9Diff(json, r);
check(dr.names.parts?.reordered && !dr.names.parts.changed.length && !dr.names.parts.added.length, 'two parts swapped: "the order changed", no part changed');

// a different version (1.1, curves)
const v = ug9Diff(ug9, fs.readFileSync('tests/v11/model.ug9'));
check(v.header.version.join() === '1.0,1.1' && v.tables.some((x) => x.name === 'keyCurves' && x.count[0] === 0 && x.count[1] > 0), 'version 1.0 → 1.1, the curves\' table appears');

// the command line
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ug9diff-'));
fs.writeFileSync(path.join(dir, 'b.ug9'), after);
const run = (a, b) => { try { return [0, execFileSync('node', ['tools/ug9_diff.mjs', a, b], { encoding: 'utf8' })]; } catch (e) { return [e.status, e.stdout]; } };
const [c0, o0] = run('samples/basic/model.ug9', 'samples/basic/model.json'), [c1, o1] = run('samples/basic/model.ug9', path.join(dir, 'b.ug9'));
check(c0 === 0 && o0.startsWith('same') && c1 === 1 && o1.startsWith('different') && o1.includes('head: rotation'), 'command line: 0 and "same", 1 and the list');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : '\nall ug9 diff checks passed');
process.exit(failures ? 1 : 0);
