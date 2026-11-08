import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { filesHash, refreshPublicFileDates, tagModuleSpecifiers, tagPublicFiles } from './webfiles';

function tmpPublic(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-public-'));
  fs.writeFileSync(
    path.join(d, 'index.html'),
    '<link rel="stylesheet" href="ol.css">\n<script src="ol.js"></script>\n<script type="module" src="rp-plan.js"></script>\n'
  );
  fs.writeFileSync(path.join(d, 'rp-core.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(d, 'rp-plan.js'), "import { a } from './rp-core.js';\nconsole.log(a);\n");
  fs.writeFileSync(path.join(d, 'ol.js'), '// ol\n');
  fs.writeFileSync(path.join(d, 'ol.css'), 'body{}\n');
  return d;
}

test('the files on disk carry the version tag, re-tagging replaces it, and tags do not change the hash', () => {
  const pub = tmpPublic();
  const h0 = filesHash(pub);
  assert.equal(tagPublicFiles(pub, 'abc12345'), 2, 'index.html and rp-plan.js rewritten');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.match(html, /href="ol\.css\?v=abc12345"/);
  assert.match(html, /src="ol\.js\?v=abc12345"/);
  assert.match(html, /src="rp-plan\.js\?v=abc12345"/);
  assert.match(fs.readFileSync(path.join(pub, 'rp-plan.js'), 'utf8'), /from '\.\/rp-core\.js\?v=abc12345'/);
  assert.equal(filesHash(pub), h0, 'the tag is not part of the hash');
  // A `?v=` that is content, not an asset tag, is part of the hash.
  fs.writeFileSync(path.join(pub, 'rp-core.js'), "export const a = 1;\nexport const url = '/api/thing?v=1';\n");
  const h1 = filesHash(pub);
  assert.notEqual(h1, h0);
  fs.writeFileSync(path.join(pub, 'rp-core.js'), "export const a = 1;\nexport const url = '/api/thing?v=2';\n");
  assert.notEqual(filesHash(pub), h1, 'a changed query in the code changes the hash');
  assert.equal(tagPublicFiles(pub, 'abc12345'), 0, 'already tagged with this tag: nothing rewritten');
  assert.equal(fs.readdirSync(pub).filter(f => f.includes('.tmp-')).length, 0, 'no temporary files left behind');
  assert.equal(tagPublicFiles(pub, 'def67890'), 2);
  assert.match(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), /rp-plan\.js\?v=def67890"/);
  assert.doesNotMatch(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), /abc12345/);
  assert.equal(tagPublicFiles(pub, 'def67890'), 0, 'already tagged: nothing rewritten');
  fs.rmSync(pub, { recursive: true, force: true });
});

test('refreshPublicFileDates tags and dates the files once per content change', () => {
  const pub = tmpPublic();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  const logs: string[] = [];
  refreshPublicFileDates(
    pub,
    data,
    m => logs.push(m),
    m => logs.push('ERROR ' + m)
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /tagged 2 file\(s\) with \?v=[0-9a-f]{8}/);
  const tag = /\?v=([0-9a-f]{8})/.exec(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'))![1];
  assert.equal(fs.readFileSync(path.join(data, 'public-files.hash'), 'utf8'), tag, 'the tag is the stamp');
  refreshPublicFileDates(
    pub,
    data,
    m => logs.push(m),
    m => logs.push('ERROR ' + m)
  );
  assert.equal(logs.length, 1, 'unchanged files: nothing done');
  fs.writeFileSync(path.join(pub, 'rp-core.js'), 'export const a = 2;\n');
  refreshPublicFileDates(
    pub,
    data,
    m => logs.push(m),
    m => logs.push('ERROR ' + m)
  );
  assert.equal(logs.length, 2);
  const tag2 = /\?v=([0-9a-f]{8})/.exec(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'))![1];
  assert.notEqual(tag2, tag, 'a content change gives a new tag');
  fs.rmSync(pub, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

test('refreshPublicFileDates: the same files deployed again untagged and dated 1985 are tagged and dated again', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wrp-data-'));
  const logs: string[] = [];
  const refresh = (pub: string): void =>
    refreshPublicFileDates(
      pub,
      data,
      m => logs.push(m),
      m => logs.push('ERROR ' + m)
    );
  const first = tmpPublic();
  refresh(first);
  const tag = /\?v=([0-9a-f]{8})/.exec(fs.readFileSync(path.join(first, 'index.html'), 'utf8'))![1];
  // A server-only update: npm's copies of the same files, untagged, with npm's date.
  const again = tmpPublic();
  const npmDate = new Date('1985-10-26T08:15:00Z');
  for (const f of fs.readdirSync(again)) fs.utimesSync(path.join(again, f), npmDate, npmDate);
  refresh(again);
  assert.equal(logs.length, 2, logs.join('\n'));
  assert.match(fs.readFileSync(path.join(again, 'index.html'), 'utf8'), new RegExp(`rp-plan\\.js\\?v=${tag}"`), 'the same tag again');
  assert.ok(fs.statSync(path.join(again, 'rp-plan.js')).mtimeMs > npmDate.getTime() + 1e6, 'dated now');
  refresh(again);
  assert.equal(logs.length, 2, 'tagged files, same content: nothing done');
  for (const d of [first, again, data]) fs.rmSync(d, { recursive: true, force: true });
});

test('every import and re-export of a module carries the tag, over several lines too; nothing else is touched', () => {
  const src = [
    "import { a } from './rp-core.js';",
    'import {',
    '  b,',
    '  c,',
    "} from './rp-units.js?v=old12345';",
    "export { d, e } from './rp-units.js';",
    "export const url = './rp-plan.js';",
    "const m = import('/x/rp-units.js');",
  ].join('\n');
  assert.equal(
    tagModuleSpecifiers(src, 'abc12345'),
    [
      "import { a } from './rp-core.js?v=abc12345';",
      'import {',
      '  b,',
      '  c,',
      "} from './rp-units.js?v=abc12345';",
      "export { d, e } from './rp-units.js?v=abc12345';",
      "export const url = './rp-plan.js';",
      "const m = import('/x/rp-units.js');",
    ].join('\n')
  );
});
