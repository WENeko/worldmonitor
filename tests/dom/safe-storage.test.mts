import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';

/** Android WebView with DOM storage disabled: the property itself is null. */
function stubNullStorage(): void {
  vi.stubGlobal('localStorage', null);
}

/** Sandboxed iframe or blocked cookies: reading the property throws. */
function stubThrowingStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: access is denied for this document');
    },
  });
}

/** Storage is present but full, so only the write throws. */
function stubFullStorage(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('safe storage', () => {
  it('round-trips a value when storage works', () => {
    safeStorageSet('wm-test-key', '1');
    expect(safeStorageGet('wm-test-key')).toBe('1');

    safeStorageRemove('wm-test-key');
    expect(safeStorageGet('wm-test-key')).toBeNull();
  });

  it('reports a missing key as null rather than undefined', () => {
    expect(safeStorageGet('wm-key-that-was-never-set')).toBeNull();
  });

  for (const [shape, stub] of [
    ['null storage', stubNullStorage],
    ['throwing storage', stubThrowingStorage],
  ] as const) {
    it(`degrades to no-op reads and writes under ${shape}`, () => {
      stub();

      expect(() => safeStorageSet('wm-test-key', '1')).not.toThrow();
      expect(() => safeStorageRemove('wm-test-key')).not.toThrow();
      expect(safeStorageGet('wm-test-key')).toBeNull();
    });
  }

  it('swallows a quota failure on write', () => {
    stubFullStorage();

    expect(() => safeStorageSet('wm-test-key', '1')).not.toThrow();
  });
});
