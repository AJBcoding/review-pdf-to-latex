// Unit tests for the per-channel IPC arg validators (rev-x4).
import { describe, expect, it } from 'vitest';
import { assertObjectArg, assertPathArg, assertStringArg } from './ipc-validators.js';

describe('assertPathArg', () => {
  it('accepts a normal absolute path', () => {
    expect(() => assertPathArg('t', '/Users/me/doc.pdf')).not.toThrow();
  });

  it('accepts a relative path (the app resolves relative-to-cwd in dev)', () => {
    expect(() => assertPathArg('t', './doc.pdf')).not.toThrow();
  });

  it('rejects a non-string', () => {
    expect(() => assertPathArg('t', 42)).toThrow(TypeError);
    expect(() => assertPathArg('t', undefined)).toThrow(/expected a string path/);
  });

  it('names null distinctly in the message (not "object")', () => {
    expect(() => assertPathArg('t', null)).toThrow(/got null/);
  });

  it('rejects an empty path', () => {
    expect(() => assertPathArg('t', '')).toThrow(RangeError);
  });

  it('rejects a NUL byte (path-truncation vector)', () => {
    expect(() => assertPathArg('t', '/etc/passwd\0.pdf')).toThrow(/NUL byte/);
  });

  it('prefixes the label so a rejection is traceable to its channel', () => {
    expect(() => assertPathArg('fs:readFileBytes', 7)).toThrow(/^fs:readFileBytes:/);
  });
});

describe('assertStringArg', () => {
  it('accepts a normal string, including empty', () => {
    expect(() => assertStringArg('t', 'abc')).not.toThrow();
    expect(() => assertStringArg('t', '')).not.toThrow();
  });

  it('rejects a non-string', () => {
    expect(() => assertStringArg('t', {})).toThrow(TypeError);
  });

  it('rejects a NUL byte', () => {
    expect(() => assertStringArg('t', 'a\0b')).toThrow(/NUL byte/);
  });
});

describe('assertObjectArg', () => {
  it('accepts a plain object', () => {
    expect(() => assertObjectArg('t', { a: 1 })).not.toThrow();
  });

  it('rejects null, arrays, and primitives', () => {
    expect(() => assertObjectArg('t', null)).toThrow(TypeError);
    expect(() => assertObjectArg('t', [1, 2])).toThrow(/expected an object/);
    expect(() => assertObjectArg('t', 'str')).toThrow(TypeError);
  });
});
