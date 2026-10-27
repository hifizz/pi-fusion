import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

/** Check existing ancestors as well as lexical paths, so symlinks cannot escape. */
export function localPath(path: string): string {
  const absolute = resolve(ROOT, path);
  const check = (candidate: string) => {
    const rel = relative(ROOT, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("Writes and evaluation artifacts must stay inside pi-fusion");
    }
  };
  check(absolute);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  check(realpathSync(ancestor));
  return absolute;
}

export function makeWorkspace(prefix: string): string {
  if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error("Invalid workspace prefix");
  const parent = localPath(".work");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, prefix));
}

/** Symlinks/devices are rejected, including links left behind by an evaluated agent. */
export function copyTree(source: string, destination: string, excluded: Set<string> = new Set()): void {
  localPath(destination);
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in evaluation workspaces");
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new Error("Refusing to copy through a symlink");
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (!excluded.has(name)) copyTree(join(source, name), join(destination, name), excluded);
    }
  } else if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  } else {
    throw new Error("Only regular files and directories are allowed in task fixtures");
  }
}

export function assertRegularTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Task fixtures must not contain symlinks");
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) assertRegularTree(join(path, name));
  } else if (!stat.isFile()) {
    throw new Error("Task fixtures must contain only regular files");
  }
}
