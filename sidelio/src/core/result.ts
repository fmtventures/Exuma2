import { SidelioError } from './errors.ts';

/**
 * Explicit result type for operations that fail as part of normal business
 * flow (import extraction, AI planning, permission checks). Exceptions are
 * reserved for programmer error and infrastructure faults.
 */
export type Result<T, E = SidelioError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw r.error;
}

export function mapResult<T, U>(r: Result<T>, fn: (value: T) => U): Result<U> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Partition a batch of results, keeping failures for reporting. */
export function partition<T, E>(results: Result<T, E>[]): { values: T[]; errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return { values, errors };
}
