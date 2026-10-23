import { constants, promises as fsp, realpath as realpathCb } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';

/** The file operations the runner needs, so tests can use an in-memory fake. */
export interface Fs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  /** Creates parent directories as needed. */
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>;
  /** Creates parent directories as needed. */
  copyFile(source: string, target: string, options?: { mode?: number }): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Recursive; a missing path is not an error. */
  remove(path: string): Promise<void>;
  /** Names of the entries in a folder. */
  list(path: string): Promise<string[]>;
  /** The on-disk spelling of an existing path: symlinks resolved, the filesystem's letter case. */
  realpath(path: string): Promise<string>;
  /**
   * Writes `dir/name` without following symlinks: rejects with code "ELOOP" when `dir` or the file
   * is a symlink (a branch can commit either), creating `dir` (one level) if it is missing.
   */
  writeFileNoFollow(dir: string, name: string, content: string, mode: number): Promise<void>;
}

function symlinkError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`refusing to write through the symlink ${path}`), { code: 'ELOOP' });
}

export const nodeFs: Fs = {
  async exists(path) {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (path) => fsp.readFile(path, 'utf8'),
  async writeFile(path, content, options = {}) {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, content, { mode: options.mode });
    if (options.mode !== undefined) await fsp.chmod(path, options.mode);
  },
  async copyFile(source, target, options = {}) {
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
    if (options.mode !== undefined) await fsp.chmod(target, options.mode);
  },
  async mkdir(path) {
    await fsp.mkdir(path, { recursive: true });
  },
  async remove(path) {
    await fsp.rm(path, { recursive: true, force: true });
  },
  list: (path) => fsp.readdir(path),
  // The native call returns the case the filesystem stores (the JS one keeps the typed case).
  realpath: promisify(realpathCb.native),
  async writeFileNoFollow(dir, name, content, mode) {
    const stat = await fsp.lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (stat?.isSymbolicLink()) throw symlinkError(dir);
    if (!stat) await fsp.mkdir(dir);
    else if (!stat.isDirectory()) throw new Error(`${dir} is not a folder`);
    const path = join(dir, name);
    // O_NOFOLLOW: the open itself fails (ELOOP) on a symlink, with no window between check and write.
    const handle = await fsp
      .open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode)
      .catch((err: NodeJS.ErrnoException) => {
        throw err.code === 'ELOOP' ? symlinkError(path) : err;
      });
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  },
};
