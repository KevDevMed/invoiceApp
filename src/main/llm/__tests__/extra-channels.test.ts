/**
 * The bend around the frozen contract, pinned down.
 *
 * Two things must stay true: the contract's own schema still validates every
 * `llm:catalog` payload, and the op fields survive the intersection instead of
 * being stripped the way the contract schema alone would strip them.
 */

import { describe, expect, it } from 'vitest';

import { IPC_CONTRACT } from '../../../shared/ipc-contract';
import {
  CatalogRequestSchema,
  CheckSupportRequest,
  HfLookupRequest,
  SmokeTestRequest,
  opOf,
} from '../extra-channels';

describe('CatalogRequestSchema', () => {
  it('still accepts the plain payload the original contract declared', () => {
    expect(CatalogRequestSchema.parse({})).toEqual({});
    expect(CatalogRequestSchema.parse({ refresh: true })).toMatchObject({ refresh: true });
  });

  it('still rejects what the contract schema rejected', () => {
    expect(() => CatalogRequestSchema.parse({ refresh: 'yes' })).toThrowError();
    // The contract's schema alone would also reject these.
    expect(IPC_CONTRACT['llm:catalog'].request.safeParse({ refresh: 'yes' }).success).toBe(false);
  });

  it('carries the op through, which the contract schema alone would strip', () => {
    const payload = { op: 'checkSupport', repo: 'a/b', filename: 'm.gguf' };

    // The contract schema on its own drops everything it does not declare…
    expect(IPC_CONTRACT['llm:catalog'].request.parse(payload)).toEqual({});
    // …the intersection keeps it.
    expect(CatalogRequestSchema.parse(payload)).toMatchObject(payload);
  });

  it('rejects an op that is not one of ours', () => {
    expect(() => CatalogRequestSchema.parse({ op: 'rm -rf' })).toThrowError();
  });
});

describe('opOf', () => {
  it('treats a missing op as the plain catalog listing', () => {
    expect(opOf({})).toBe('catalog');
    expect(opOf({ refresh: true })).toBe('catalog');
    expect(opOf(undefined)).toBe('catalog');
  });

  it('reads each declared op', () => {
    expect(opOf({ op: 'systemInfo' })).toBe('systemInfo');
    expect(opOf({ op: 'checkSupport' })).toBe('checkSupport');
    expect(opOf({ op: 'hfLookup' })).toBe('hfLookup');
    expect(opOf({ op: 'smokeTest' })).toBe('smokeTest');
  });

  it('throws on anything else rather than falling back to the catalog', () => {
    expect(() => opOf({ op: 'checkSupprt' })).toThrowError(/Unknown llm:catalog op/);
  });
});

describe('per-op schemas', () => {
  it('validates checkSupport', () => {
    expect(
      CheckSupportRequest.parse({ op: 'checkSupport', repo: 'a/b', filename: 'm.gguf' }),
    ).toMatchObject({ repo: 'a/b', filename: 'm.gguf' });
    expect(() => CheckSupportRequest.parse({ op: 'checkSupport', repo: 'a/b' })).toThrowError();
    expect(() =>
      CheckSupportRequest.parse({ op: 'checkSupport', repo: 'a/b', filename: 'm.gguf', ctxSize: 1 }),
    ).toThrowError();
  });

  it('validates hfLookup and smokeTest', () => {
    expect(HfLookupRequest.parse({ op: 'hfLookup', repo: 'a/b' }).repo).toBe('a/b');
    expect(() => HfLookupRequest.parse({ op: 'hfLookup' })).toThrowError();
    expect(SmokeTestRequest.parse({ op: 'smokeTest', modelId: 'x' }).modelId).toBe('x');
    expect(() => SmokeTestRequest.parse({ op: 'smokeTest', modelId: '' })).toThrowError();
    expect(() =>
      SmokeTestRequest.parse({ op: 'smokeTest', modelId: 'x', maxTokens: 10_000 }),
    ).toThrowError();
  });
});
