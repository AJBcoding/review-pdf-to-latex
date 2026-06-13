import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './md-viewer';

describe('parseFrontmatter', () => {
  it('parses a valid frontmatter block', () => {
    const text = '---\ntitle: My Doc\nauthor: AJB\n---\nBody content here.';
    const { frontmatter, body, bodyOffset } = parseFrontmatter(text);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.fields).toEqual([
      { key: 'title', value: 'My Doc' },
      { key: 'author', value: 'AJB' },
    ]);
    expect(body).toBe('Body content here.');
    expect(bodyOffset).toBe(text.length - 'Body content here.'.length);
  });

  it('returns null frontmatter when no --- block is present', () => {
    const text = 'Just a plain markdown file.';
    const result = parseFrontmatter(text);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(text);
    expect(result.bodyOffset).toBe(0);
  });

  it('rejects a horizontal-rule pair with no key-value fields (false-match guard)', () => {
    const text = '---\nThis is just text, not YAML\n---\nReal body here.';
    const result = parseFrontmatter(text);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(text);
    expect(result.bodyOffset).toBe(0);
  });

  it('rejects an empty --- block as not frontmatter', () => {
    const text = '---\n\n---\nBody.';
    const result = parseFrontmatter(text);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(text);
  });

  it('prefix + body reconstructs the original file (getContent contract)', () => {
    const original = '---\ntitle: Test\ndate: 2026-01-01\n---\n# Heading\n\nContent.';
    const { body, bodyOffset } = parseFrontmatter(original);
    const prefix = original.slice(0, bodyOffset);
    // Simulate a user edit: append text to the body
    const editedBody = body + '\n\nNew paragraph.';
    const fullContent = prefix + editedBody;
    // Frontmatter block is preserved intact
    expect(fullContent.startsWith(prefix)).toBe(true);
    // Body edits are reflected
    expect(fullContent).toContain('New paragraph.');
    // Original frontmatter fields survive
    expect(fullContent).toContain('title: Test');
  });

  it('handles frontmatter with trailing spaces on delimiter lines', () => {
    const text = '---  \ntitle: Spaced\n---  \nBody.';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.fields[0]).toEqual({ key: 'title', value: 'Spaced' });
    expect(body).toBe('Body.');
  });
});
