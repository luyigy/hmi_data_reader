import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Reader {
  read(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  /** Lists tracked files under a directory; used by the commit-time numbering
   * uniqueness check. Readers without a listable backend may omit it, in which
   * case the check is skipped. */
  list?(dirPath: string): Promise<string[]>;
}

const git = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      signal,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });

export class GitRefReader implements Reader {
  constructor(
    private readonly cwd: string,
    private readonly ref: string,
    private readonly signal = new AbortController().signal,
  ) {}

  read(filePath: string) {
    return git(this.cwd, this.signal, 'show', `${this.ref}:${filePath}`);
  }

  exists(filePath: string) {
    return git(this.cwd, this.signal, 'cat-file', '-e', `${this.ref}:${filePath}`).then(() => true, () => false);
  }

  list(dirPath: string) {
    return git(this.cwd, this.signal, 'ls-tree', '-r', '--name-only', this.ref, '--', dirPath)
      .then((output) => output.split('\n').filter(Boolean));
  }
}

export class WorkingTreeReader implements Reader {
  private readonly fallback: GitRefReader;

  constructor(
    private readonly cwd: string,
    fallbackRef = 'HEAD',
    signal = new AbortController().signal,
  ) {
    this.fallback = new GitRefReader(cwd, fallbackRef, signal);
  }

  async read(filePath: string) {
    try {
      return await readFile(path.resolve(this.cwd, filePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.fallback.read(filePath);
    }
  }

  async exists(filePath: string) {
    try {
      await access(path.resolve(this.cwd, filePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.fallback.exists(filePath);
    }
  }

  list(dirPath: string) {
    // The uniqueness check is authoritative at commit time (GitRefReader);
    // for working-tree validation the tracked ref listing plus the explicit
    // filePaths already cover newly added documents.
    return this.fallback.list(dirPath);
  }
}
