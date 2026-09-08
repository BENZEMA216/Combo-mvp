import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  opendirSync,
  realpathSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

import { ReceiverError } from './contract.js';

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
/** Detects stable symlinks and directory swaps, not an OS sandbox against same-UID attackers. */
export class ProjectFiles {
  private readonly directories = new Map<string, Stats>();
  readonly rootIdentity: { device: string; inode: string };
  constructor(readonly root: string) {
    try {
      if (
        !isAbsolute(root) ||
        resolve(root) !== root ||
        parse(root).root === root ||
        root === homedir() ||
        realpathSync(root) !== root
      )
        throw new Error('root');
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('root');
      this.directories.set(root, stat);
      this.rootIdentity = { device: String(stat.dev), inode: String(stat.ino) };
    } catch {
      throw new ReceiverError('PROJECT_UNAVAILABLE');
    }
  }
  path(relative: string): string {
    if (
      !relative ||
      relative
        .split('/')
        .some(
          (part) =>
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && !['.combo', '.agents'].includes(part),
        )
    )
      throw new ReceiverError('INSTALL_CONFLICT');
    const result = resolve(this.root, relative);
    if (!result.startsWith(`${this.root}/`)) throw new ReceiverError('INSTALL_CONFLICT');
    return result;
  }
  assertBound(): void {
    try {
      for (const [path, expected] of this.directories) {
        const actual = lstatSync(path);
        if (
          !actual.isDirectory() ||
          actual.isSymbolicLink() ||
          !sameIdentity(actual, expected) ||
          realpathSync(path) !== path
        )
          throw new Error('changed');
      }
    } catch {
      throw new ReceiverError('PROJECT_UNAVAILABLE');
    }
  }
  directory(relative: string, create: boolean, exclusive = false): boolean {
    this.assertBound();
    const parts = relative.split('/');
    let created = false;
    for (let i = 0; i < parts.length; i += 1) {
      const path = this.path(parts.slice(0, i + 1).join('/'));
      this.assertBound();
      try {
        const stat = lstatSync(path);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          realpathSync(path) !== path ||
          (exclusive && i === parts.length - 1)
        )
          throw new ReceiverError('INSTALL_CONFLICT');
        const expected = this.directories.get(path);
        if (expected && !sameIdentity(expected, stat))
          throw new ReceiverError('PROJECT_UNAVAILABLE');
        this.directories.set(path, stat);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        if (!create) return false;
        // No recursive mkdir: every parent has already been checked and bound.
        mkdirSync(path, { mode: 0o700 });
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
          throw new ReceiverError('PROJECT_UNAVAILABLE');
        this.directories.set(path, stat);
        if (i === parts.length - 1) created = true;
      }
    }
    this.assertBound();
    return create ? created : true;
  }
  read(relative: string, maxBytes: number): Buffer {
    if (!this.directory(relative.split('/').slice(0, -1).join('/'), false))
      throw new ReceiverError('INSTALL_CONFLICT');
    this.assertBound();
    const path = this.path(relative);
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > maxBytes ||
      (before.mode & 0o777) !== 0o400
    )
      throw new ReceiverError('INSTALL_CONFLICT');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (
        !sameIdentity(before, opened) ||
        !opened.isFile() ||
        opened.size !== before.size ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o400
      )
        throw new ReceiverError('INSTALL_CONFLICT');
      this.assertBound();
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) throw new ReceiverError('INSTALL_CONFLICT');
        offset += count;
      }
      const after = fstatSync(fd);
      if (
        !sameIdentity(lstatSync(path), opened) ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        after.nlink !== 1 ||
        (after.mode & 0o777) !== 0o400
      )
        throw new ReceiverError('INSTALL_CONFLICT');
      this.assertBound();
      return buffer;
    } finally {
      closeSync(fd);
    }
  }
  write(relative: string, bytes: Uint8Array): void {
    this.directory(relative.split('/').slice(0, -1).join('/'), true);
    this.assertBound();
    const path = this.path(relative);
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, lstatSync(path)))
        throw new ReceiverError('INSTALL_CONFLICT');
      this.assertBound();
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (count <= 0) throw new ReceiverError('INSTALL_INCOMPLETE');
        offset += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!this.read(relative, bytes.length).equals(bytes))
      throw new ReceiverError('INSTALL_INCOMPLETE');
  }
  inventory(relative: string): string[] {
    if (!this.directory(relative, false)) throw new ReceiverError('INSTALL_CONFLICT');
    const result: string[] = [];
    const walk = (folder: string, depth: number) => {
      if (depth > 5) throw new ReceiverError('INSTALL_CONFLICT');
      this.assertBound();
      const directory = opendirSync(this.path(folder), { bufferSize: 1 });
      let count = 0;
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          count += 1;
          if (count > 10) throw new ReceiverError('INSTALL_CONFLICT');
          const child = `${folder}/${entry.name}`;
          if (entry.isDirectory()) {
            this.directory(child, false);
            result.push(`${child.slice(relative.length + 1)}/`);
            walk(child, depth + 1);
          } else if (entry.isFile()) result.push(child.slice(relative.length + 1));
          else throw new ReceiverError('INSTALL_CONFLICT');
          if (result.length > 20) throw new ReceiverError('INSTALL_CONFLICT');
        }
      } finally {
        directory.closeSync();
      }
    };
    walk(relative, 0);
    this.assertBound();
    return result.sort();
  }
  syncParent(relative: string): void {
    this.assertBound();
    const fd = openSync(dirname(this.path(relative)), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export function expectedInventory(files: readonly string[]): string[] {
  const result = new Set(files);
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) result.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...result].sort();
}
