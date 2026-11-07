/**
 * The files the plugin keeps its records in: route jobs (plugin/jobs.ts), departure windows and ensemble sets
 * (plugin/jobseries.ts), one JSON file each in a folder of their own, and each ensemble's record of its cycle in use
 * (data/ensemble.ts). They are saved, removed and read back here, the one way for all of them. A failure is never
 * thrown: it is returned, or reported through `log`, and what it means for the record (its save_error, a file left as
 * it is) is its owner's to say.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Save `value` as `file`: written beside it and renamed over it, so a reader never sees half a file. Null when saved,
 * else why not; a partial copy left by the failed write is removed, or the answer also says why it could not be.
 * `indent`: for a file people read and edit by hand, the spaces per level, the file ending with a newline; absent,
 * one line. A value with no JSON form (undefined, a function, a symbol: JSON.stringify gives undefined) or that JSON
 * cannot write (a cycle, a BigInt: it throws) is not saved, and the file is left as it is.
 */
export function saveJson(file: string, value: unknown, indent?: number): string | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, indent);
  } catch (err) {
    return `the value cannot be written as JSON (${(err as Error).message}); nothing written`;
  }
  if (typeof json !== 'string') return `the value (${typeof value}) has no JSON form; nothing written`;
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, indent === undefined ? json : `${json}\n`);
    fs.renameSync(tmp, file);
    return null;
  } catch (err) {
    const why = (err as Error).message;
    try {
      // existsSync never throws; the partial copy is there only when the write got that far.
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
      return why;
    } catch (rmErr) {
      return `${why}; its partial copy ${path.basename(tmp)} could not be removed: ${(rmErr as Error).message}`;
    }
  }
}

/** Remove `file`: null when removed or never saved (no file), else why not. */
export function removeJson(file: string): string | null {
  try {
    fs.unlinkSync(file);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : (err as Error).message;
  }
}

/** What a folder holds, as its log lines name it: `one` 'ensemble set', `a` 'an ensemble set', `many` 'ensemble sets'. */
export interface RecordNoun {
  one: string;
  a: string;
  many: string;
}

/** What a folder of records held (loadJsonFiles). */
export interface LoadedRecords<T> {
  /** The records restored. */
  records: T[];
  /** The names (without .json) of the files left as they are: not readable, or not holding such a record. */
  leftAsIs: string[];
  /** The folder could be listed: when not, nothing in it is known, restored or not. */
  folderRead: boolean;
}

/**
 * The records saved in `dir` (its .json files, each named by its record's id), each as `holds` recognises it. A folder
 * that cannot be read, a file that cannot be read or parsed, one that does not hold such a record, and one that holds
 * a record of another id (a copy: restoring it would write over that id's files) are reported through `log` and left
 * as they are, and the answer names them: what belongs to a record left as it is must be kept too.
 */
export function loadJsonFiles<T extends { id: string }>(
  dir: string,
  noun: RecordNoun,
  holds: (v: unknown) => v is T,
  log: (msg: string) => void
): LoadedRecords<T> {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (err) {
    log(`${noun.many}: ${dir} cannot be read (${(err as Error).message}); none restored`);
    return { records: [], leftAsIs: [], folderRead: false };
  }
  const records: T[] = [];
  const leftAsIs: string[] = [];
  for (const f of files) {
    let v: unknown;
    try {
      v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      log(`${noun.one} file ${f} cannot be read (${(err as Error).message}); left as it is, not restored`);
      leftAsIs.push(f.slice(0, -'.json'.length));
      continue;
    }
    const name = f.slice(0, -'.json'.length);
    if (!holds(v)) {
      log(`${noun.one} file ${f} does not hold ${noun.a}; left as it is, not restored`);
      leftAsIs.push(name);
      continue;
    }
    if (v.id !== name) {
      log(`${noun.one} file ${f} holds ${noun.a} of another id (${v.id}); left as it is, not restored`);
      leftAsIs.push(name);
      continue;
    }
    records.push(v);
  }
  return { records, leftAsIs, folderRead: true };
}
