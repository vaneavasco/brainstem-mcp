import { VaultError } from './types.ts';

export const TRASH_DIR = '.trash';
/** Folder the server keeps its own state in. Never reachable through a tool. */
export const RESERVED_DIR = '_brainstem';

export function isReservedPath(p: string): boolean {
  return p === RESERVED_DIR || p.startsWith(`${RESERVED_DIR}/`);
}
const MAX_PATH_CHARS = 1024;
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);
const FORBIDDEN_CHARS = /[:*?"<>|]/;
const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export interface PathPolicyOptions {
  allowInternal?: boolean;
}

function reject(reason: string, input: string): never {
  throw new VaultError('INVALID_PATH', `Invalid vault path ${JSON.stringify(input)}: ${reason}.`);
}

/**
 * Normalizes a caller-supplied vault path and rejects anything that could escape
 * the vault or reach hidden/internal files. Returns '' for the vault root.
 */
export function normalizeVaultPath(input: unknown, opts: PathPolicyOptions = {}): string {
  if (typeof input !== 'string') {
    throw new VaultError('INVALID_PATH', 'Path must be a string.');
  }
  const trimmed = input.trim();
  const normalized = trimmed.normalize('NFC');
  if (normalized.length > MAX_PATH_CHARS)
    reject(`longer than ${MAX_PATH_CHARS} characters`, '<too long>');
  if (CONTROL_CHARS.test(normalized)) reject('contains control characters', trimmed);
  if (URI_SCHEME.test(normalized)) reject('URIs are not vault paths', trimmed);

  const slashed = normalized.replace(/\\/g, '/');
  if (slashed.startsWith('/') && slashed.length > 1)
    reject('absolute paths are not allowed', trimmed);
  if (WINDOWS_DRIVE.test(slashed)) reject('absolute paths are not allowed', trimmed);

  const segments: string[] = [];
  for (const raw of slashed.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') reject('parent-directory traversal is not allowed', trimmed);
    if (FORBIDDEN_CHARS.test(raw))
      reject('contains characters not allowed in vault paths (: * ? " < > |)', trimmed);
    if (raw.startsWith('.')) {
      const internalOk = opts.allowInternal === true && segments.length === 0 && raw === TRASH_DIR;
      if (!internalOk) reject('hidden files and folders are not accessible', trimmed);
    }
    if (segments.length === 0 && raw === RESERVED_DIR && opts.allowInternal !== true) {
      reject(`${RESERVED_DIR}/ is reserved for the server`, trimmed);
    }
    segments.push(raw);
  }
  return segments.join('/');
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function baseName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Best-effort normalization for contexts that must never throw — per-item error reporting
 * (`batchRead`, `batchFrontmatterUpdate`) and lock-key derivation for a batch of possibly-invalid
 * paths. Falls back to the raw input (stringified) when it doesn't even normalize, so an invalid
 * path can still be reported or used as a (deliberately inert) lock key instead of aborting the
 * whole call.
 */
export function normalizedOrRaw(input: unknown): string {
  try {
    return normalizeVaultPath(input);
  } catch {
    return String(input);
  }
}
