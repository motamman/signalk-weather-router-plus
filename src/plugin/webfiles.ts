/**
 * The web app's files on disk: content hashes, and the re-dating that
 * makes browsers refetch them after an update (see refreshPublicFileDates).
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The version tags tagPublicFiles writes, and nothing else: an asset
 * reference (`ol.js?v=…`, `rp-plan.js?v=…`, `ol.css?v=…`) and a module
 * import specifier (`'./rp-core.js?v=…'`). Any other `?v=` in a file is
 * content, and a change to it must change the hash.
 */
const ASSET_TAG = /((?:^|[/"'])(?:ol|rp-[a-z]+)\.(?:js|css))\?v=[0-9a-z]+/g;

/** The file's text with the tags tagPublicFiles writes removed (what the hash is taken over). */
export function untagged(text: string): string {
  return text.replace(ASSET_TAG, '$1');
}

/**
 * A short hash of the files under a directory (name and content), or
 * 'nofiles'. The version tags tagPublicFiles writes into .html and .js
 * files are left out of the hash, so tagging the files does not change it.
 */
export function filesHash(dir: string, exclude: string[] = []): string {
  const h = createHash('sha1');
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      const rel = path.relative(dir, p);
      if (exclude.includes(rel)) continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(?:html|js)$/.test(f)) h.update(rel).update(untagged(fs.readFileSync(p, 'utf8')));
      else h.update(rel).update(fs.readFileSync(p));
    }
  };
  try {
    walk(dir);
  } catch {
    return 'nofiles';
  }
  return h.digest('hex').slice(0, 8);
}

/** Modules in public/ the panel imports (with its own ?v=, so they count in its hash). */
const PANEL_SHARED = ['rp-units.js', 'rp-prefs.js'];

/** The panel's files (public/plotterext and the shared modules it imports), for its cache-busting URL. */
export function panelFilesHash(publicDir: string): string {
  const h = createHash('sha1').update(filesHash(path.join(publicDir, 'plotterext')));
  for (const f of PANEL_SHARED) {
    try {
      h.update(f).update(untagged(fs.readFileSync(path.join(publicDir, f), 'utf8')));
    } catch {
      h.update(f);
    }
  }
  return h.digest('hex').slice(0, 8);
}

/**
 * index.html's script and style references tagPublicFiles tags (the tag, when there is one, in group 3); the plugin's
 * /ui route (api.ts servePublic) tags the page it serves with it too.
 */
export const PAGE_REF = /(<(?:script|link)[^>]+(?:src|href)=")((?:ol|rp-[a-z]+)\.(?:js|css))(?:\?v=([0-9a-z]+))?"/g;

/**
 * A web app module's text with `?v=<tag>` on each of its relative import and re-export specifiers of the other modules
 * (`import … from './rp-core.js'`, an import spread over several lines, `export { … } from './rp-units.js'`), an
 * older tag replaced: tagPublicFiles writes it into the files, the plugin's /ui route into what it serves (api.ts
 * servePublic), so the browser sees one URL, and one module instance, per file: an `export … from` left bare would
 * load a second instance of the module.
 */
export function tagModuleSpecifiers(text: string, tag: string): string {
  return text.replace(
    /^(\s*(?:import\b[^'";]*?(?:\bfrom\s*)?|export\b[^'";]*\bfrom\s*)['"]\.\/rp-[a-z]+\.js)(?:\?v=[0-9a-z]+)?(['"])/gm,
    `$1?v=${tag}$2`
  );
}

/**
 * Write the version tag into the files on disk: index.html's script and
 * style tags and the ES modules' relative import specifiers get
 * `?v=<tag>` (an older tag is replaced). Signal K serves the web app
 * from `public/` as static files, untouched by the plugin's own `/ui`
 * route that tags the page as it is served, so the files themselves must
 * carry the tag or a browser keeps running old modules after an update
 * (brain, 2026-10-02: the new rp-layers.js on disk, the old one in the
 * page). Returns the number of files rewritten.
 */
export function tagPublicFiles(publicDir: string, tag: string): number {
  let n = 0;
  const rewrite = (file: string, tagged: (text: string) => string): void => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const out = tagged(text);
    if (out === text) return;
    // Written beside the file and renamed over it: a failed write leaves
    // the page or module as it was, and a request served meanwhile never
    // sees a partial file.
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, file);
      n++;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  };
  rewrite(path.join(publicDir, 'index.html'), text => text.replace(PAGE_REF, `$1$2?v=${tag}"`));
  for (const f of fs.readdirSync(publicDir)) {
    if (!/^rp-[a-z]+\.js$/.test(f)) continue;
    rewrite(path.join(publicDir, f), text => tagModuleSpecifiers(text, tag));
  }
  return n;
}

/** Whether every one of index.html's script and style tags carries `?v=<tag>` (tagPublicFiles has written this tag). */
export function carriesTag(publicDir: string, tag: string): boolean {
  try {
    const refs = [...fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').matchAll(PAGE_REF)];
    return refs.length > 0 && refs.every(m => m[3] === tag);
  } catch {
    return false;
  }
}

/**
 * Files installed by npm carry npm's fixed date (26 Oct 1985), which the
 * server sends as Last-Modified, with no ETag. A browser that already has
 * a file then asks "modified since 1985?", is told "no", and keeps its old
 * copy after an update, for the web app's page, the configuration panel's
 * script and the plotter panel alike, until the URL changes. So on the
 * first start after the files changed (by their content), set their dates
 * to now, and the next conditional request gets the new file.
 *
 * Re-dating is not enough for the web app's own scripts and stylesheet:
 * a browser keeps a subresource without asking for a while after a
 * Last-Modified date, so a plain reload could still run old modules. The
 * plugin's own `/ui` route tags the page as it serves it (plugin/api.ts
 * servePublic), but the webapp link Signal K offers is its static mount
 * of `public/`, served untouched. So on the same first start the files
 * on disk are tagged too (tagPublicFiles): index.html's script and style
 * tags and the modules' import lines get `?v=<hash>`, written beside the
 * file and renamed over it. The hash leaves those tags out, so tagging
 * does not change it.
 */
export function refreshPublicFileDates(publicDir: string, dataDir: string, log: (m: string) => void, error: (m: string) => void): void {
  const pub = publicDir;
  const stamp = path.join(dataDir, 'public-files.hash');
  const hash = filesHash(pub);
  let previous: string;
  try {
    previous = fs.readFileSync(stamp, 'utf8').trim();
  } catch {
    previous = '';
  }
  // The stamp alone is not enough: a deploy of the same web files (a server-only update) puts back npm's untagged
  // copies dated 1985 with the hash unchanged, and a browser holding the untagged URL from an earlier such time keeps
  // its old module. So the files are also tagged and re-dated whenever index.html does not carry this hash's tag.
  if (hash === previous && carriesTag(pub, hash)) return;
  const now = new Date();
  let n = 0;
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        fs.utimesSync(p, now, now);
        n++;
      }
    }
  };
  try {
    const tagged = tagPublicFiles(pub, hash);
    walk(pub);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stamp, hash);
    log(
      `web files changed since the last start (${hash}): tagged ${tagged} file(s) with ?v=${hash} and dated ${n} files now, so browsers refetch them`
    );
  } catch (err) {
    error(`could not re-date the web files: ${(err as Error).message}`);
  }
}
