/**
 * The files the plugin keeps its records in: route jobs (plugin/jobs.ts), departure windows and ensemble sets
 * (plugin/jobseries.ts), one JSON file each in a folder of their own, and each ensemble's record of its cycle in use
 * (data/ensemble.ts). They are saved, removed and read back here, the one way for all of them. A failure is never thrown: it is returned, or reported through `log`, and what it means for the
 * record (its save_error, a file left as it is) is its owner's to say.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Save `value` as `file`: written beside it and renamed over it, so a reader never sees half a file. Null when saved,
 * else why not; a partial copy left by the failed write is removed, or the answer also says why it could not be.
 */
export function saveJson(file: string, value: unknown): string | null {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
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
 * The records saved in `dir` (its .json files), each as `holds` recognises it. A folder that cannot be read, a file
 * that cannot be read or parsed, and one that does not hold such a record are reported through `log` and left as
 * they are, and the answer names them: what belongs to a record left as it is must be kept too.
 */
export function loadJsonFiles<T>(
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
    if (!holds(v)) {
      log(`${noun.one} file ${f} does not hold ${noun.a}; left as it is, not restored`);
      leftAsIs.push(f.slice(0, -'.json'.length));
      continue;
    }
    records.push(v);
  }
  return { records, leftAsIs, folderRead: true };
}
