// The record files (jsonfiles.ts): saved whole or not at all, removed, read back; every failure answered, never thrown.
// The failures are made with a folder where a file belongs, which fails the same way on every OS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadJsonFiles, removeJson, saveJson } from './jsonfiles';

const NOUN = { one: 'thing', a: 'a thing', many: 'things' };
const isThing = (v: unknown): v is { id: string } => !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';

test('saveJson: saved whole, with no copy left beside it; a save that fails says why, and why its partial copy stays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jsonfiles-'));
  try {
    const file = path.join(dir, 'a.json');
    assert.equal(saveJson(file, { id: 'a' }), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { id: 'a' });
    assert.deepEqual(fs.readdirSync(dir), ['a.json']);
    // The folder it goes in is gone: the write fails before any copy exists.
    assert.ok(saveJson(path.join(dir, 'gone', 'b.json'), { id: 'b' }));
    // A folder where its copy goes: the write fails and the copy cannot be removed; both are said, the file is as it was.
    fs.mkdirSync(path.join(dir, 'a.json.tmp', 'inside'), { recursive: true });
    assert.match(saveJson(file, { id: 'changed' }) ?? '', /; its partial copy a\.json\.tmp could not be removed: /);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { id: 'a' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeJson: removed, or never saved, is null; a file that cannot be removed says why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jsonfiles-'));
  try {
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, '{}');
    assert.equal(removeJson(file), null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(removeJson(file), null, 'never saved: nothing to remove');
    fs.mkdirSync(path.join(file, 'inside'), { recursive: true });
    assert.ok(removeJson(file));
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadJsonFiles: the records, and each folder or file that cannot be read, or holds no record, reported and left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-jsonfiles-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'good' }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"id": "bro');
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ hello: 'world' }));
    fs.writeFileSync(path.join(dir, 'good.json.tmp'), '{"id": "partial"}');
    fs.mkdirSync(path.join(dir, 'folder.json'));
    const logged: string[] = [];
    const got = loadJsonFiles(dir, NOUN, isThing, m => logged.push(m));
    assert.deepEqual(got, [{ id: 'good' }]);
    assert.equal(logged.length, 3);
    assert.ok(logged.some(m => /^thing file broken\.json cannot be read \(.*\); left as it is, not restored$/.test(m)));
    assert.ok(logged.some(m => /^thing file folder\.json cannot be read \(.*\); left as it is, not restored$/.test(m)));
    assert.ok(logged.includes('thing file other.json does not hold a thing; left as it is, not restored'));
    assert.equal(fs.readdirSync(dir).length, 5, 'every file left as it is');
    const none: string[] = [];
    assert.deepEqual(
      loadJsonFiles(path.join(dir, 'gone'), NOUN, isThing, m => none.push(m)),
      []
    );
    assert.match(none[0], /^things: .* cannot be read \(.*\); none restored$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
