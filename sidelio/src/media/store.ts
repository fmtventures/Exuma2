import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';

/**
 * Object storage.
 *
 * The media module deals in keys, never in filesystem paths or bucket URLs, so
 * the storage backend is a single interface away from being S3, R2, GCS or a
 * local directory. `LocalObjectStore` is the development and test
 * implementation; a cloud one implements the same four methods.
 */

export interface StoredObject {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<Result<{ key: string; size: number }>>;
  get(key: string): Promise<Result<StoredObject>>;
  delete(key: string): Promise<Result<true>>;
  /** Public URL a browser can fetch. Local storage serves via the API. */
  url(key: string): string;
}

/** Keys are `sites/:siteId/:assetId.:ext` — flat, predictable, tenant-prefixed. */
export function assetKey(siteId: string, assetId: string, extension: string): string {
  return `sites/${siteId}/${assetId}.${extension}`;
}

/**
 * A key is untrusted input the moment an asset id comes off the wire, so it is
 * validated rather than trusted: no absolute paths, no traversal, no
 * backslashes, and the resolved path must stay inside the root.
 */
function safeKey(key: string): string | null {
  if (key === '' || key.length > 512) return null;
  if (key.includes('\0') || key.includes('\\')) return null;
  if (key.startsWith('/') || /^[a-zA-Z]:/.test(key)) return null;
  const normalized = normalize(key);
  if (normalized.startsWith('..') || normalized.includes(`..${sep}`)) return null;
  return normalized;
}

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;
  private readonly publicPrefix: string;
  private readonly types = new Map<string, string>();

  constructor(opts: { root?: string; publicPrefix?: string } = {}) {
    this.root = resolve(opts.root ?? '.sidelio-storage');
    this.publicPrefix = opts.publicPrefix ?? '/storage';
  }

  private resolveKey(key: string): string | null {
    const safe = safeKey(key);
    if (!safe) return null;
    const target = resolve(this.root, safe);
    // Belt and braces: even a key that passed validation must land inside root.
    if (target !== this.root && !target.startsWith(this.root + sep)) return null;
    return target;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<Result<{ key: string; size: number }>> {
    const target = this.resolveKey(key);
    if (!target) return fail(err('VALIDATION_FAILED', `unsafe storage key "${key}"`));
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      // Content type is not recoverable from disk, so it is tracked alongside.
      this.types.set(key, contentType);
      await writeFile(`${target}.type`, contentType, 'utf8');
      return ok({ key, size: bytes.byteLength });
    } catch (cause) {
      return fail(err('INTERNAL', `could not store ${key}`, { cause, retryable: true }));
    }
  }

  async get(key: string): Promise<Result<StoredObject>> {
    const target = this.resolveKey(key);
    if (!target) return fail(err('VALIDATION_FAILED', `unsafe storage key "${key}"`));
    try {
      const bytes = await readFile(target);
      let contentType = this.types.get(key);
      if (!contentType) {
        contentType = await readFile(`${target}.type`, 'utf8').catch(() => 'application/octet-stream');
        this.types.set(key, contentType);
      }
      return ok({ key, bytes: new Uint8Array(bytes), contentType });
    } catch {
      return fail(err('NOT_FOUND', `no stored object for ${key}`));
    }
  }

  async delete(key: string): Promise<Result<true>> {
    const target = this.resolveKey(key);
    if (!target) return fail(err('VALIDATION_FAILED', `unsafe storage key "${key}"`));
    await rm(target, { force: true });
    await rm(`${target}.type`, { force: true });
    this.types.delete(key);
    return ok(true);
  }

  url(key: string): string {
    return `${this.publicPrefix}/${key}`;
  }

  async sizeOnDisk(): Promise<number> {
    try {
      const s = await stat(this.root);
      return s.isDirectory() ? 1 : 0;
    } catch {
      return 0;
    }
  }

  get rootPath(): string {
    return this.root;
  }
}

/** In-memory store for tests — same contract, no filesystem. */
export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, StoredObject>();

  async put(key: string, bytes: Uint8Array, contentType: string) {
    const safe = safeKey(key);
    if (!safe) return fail(err('VALIDATION_FAILED', `unsafe storage key "${key}"`));
    this.objects.set(key, { key, bytes, contentType });
    return ok({ key, size: bytes.byteLength });
  }

  async get(key: string) {
    const found = this.objects.get(key);
    return found ? ok(found) : fail(err('NOT_FOUND', `no stored object for ${key}`));
  }

  async delete(key: string) {
    this.objects.delete(key);
    return ok(true as const);
  }

  url(key: string): string {
    return `/storage/${key}`;
  }

  get size(): number {
    return this.objects.size;
  }
}

export { join };
