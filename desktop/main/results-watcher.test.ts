import { describe, expect, it } from 'vitest';
import { isResultsName } from './results-watcher.js';

describe('isResultsName', () => {
  it('accepts well-formed results files', () => {
    expect(isResultsName('results-2024-01-01T12-00-00Z.json')).toBe(true);
    expect(isResultsName('results-abc123.json')).toBe(true);
    expect(isResultsName('results-x.json')).toBe(true);
  });

  it('rejects .abandoned.json tombstones', () => {
    expect(isResultsName('results-2024-01-01T12-00-00Z.abandoned.json')).toBe(false);
    expect(isResultsName('results-abc123.abandoned.json')).toBe(false);
  });

  it('rejects submit files and other non-results files', () => {
    expect(isResultsName('submit-abc123.json')).toBe(false);
    expect(isResultsName('results.json')).toBe(false);
    expect(isResultsName('foo.json')).toBe(false);
    expect(isResultsName('results-abc123.txt')).toBe(false);
  });
});
