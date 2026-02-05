import { describe, it, expect } from 'vitest';
import { escapeHtml, sanitizeMarkdown, isSafeUrl, sanitizeOutput } from '../../src/security/outputSanitizer.js';

describe('outputSanitizer', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // escapeHtml
  // ──────────────────────────────────────────────────────────────────────────

  describe('escapeHtml', () => {
    it('escapes all 5 HTML entities', () => {
      const input = `<div class="test" data-x='a' onclick="alert(1)">Tom & Jerry</div>`;
      const result = escapeHtml(input);
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&quot;');
      expect(result).toContain('&#x27;');
    });

    it('leaves safe content unchanged', () => {
      const input = 'Hello world 123';
      expect(escapeHtml(input)).toBe(input);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // sanitizeMarkdown
  // ──────────────────────────────────────────────────────────────────────────

  describe('sanitizeMarkdown', () => {
    it('strips script tags', () => {
      const input = 'Hello <script>alert("xss")</script> world';
      expect(sanitizeMarkdown(input)).toBe('Hello  world');
    });

    it('strips event handlers', () => {
      const input = '<img src="x" onclick="steal()" />';
      const result = sanitizeMarkdown(input);
      expect(result).not.toContain('onclick');
    });

    it('strips onload handlers', () => {
      const input = '<body onload="evil()">';
      const result = sanitizeMarkdown(input);
      expect(result).not.toContain('onload');
    });

    it('converts javascript: URLs to blocked:', () => {
      const input = '[click](javascript:alert(1))';
      const result = sanitizeMarkdown(input);
      expect(result).toContain('blocked:');
      expect(result).not.toMatch(/javascript\s*:/i);
    });

    it('converts data: URLs to blocked:', () => {
      const input = '<img src="data:text/html,<script>alert(1)</script>">';
      const result = sanitizeMarkdown(input);
      expect(result).toContain('blocked:');
    });

    it('strips iframe tags', () => {
      const input = '<iframe src="evil.com"></iframe>';
      expect(sanitizeMarkdown(input)).toBe('');
    });

    it('strips self-closing iframe/object/embed tags', () => {
      const input = 'before <embed src="flash.swf" /> after';
      const result = sanitizeMarkdown(input);
      expect(result).not.toContain('<embed');
    });

    it('strips object tags', () => {
      const input = '<object data="evil.swf">fallback</object>';
      expect(sanitizeMarkdown(input)).toBe('');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // isSafeUrl
  // ──────────────────────────────────────────────────────────────────────────

  describe('isSafeUrl', () => {
    it('allows http URLs', () => {
      expect(isSafeUrl('http://example.com')).toBe(true);
    });

    it('allows https URLs', () => {
      expect(isSafeUrl('https://example.com/path?q=1')).toBe(true);
    });

    it('rejects javascript: URLs', () => {
      expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    });

    it('rejects data: URLs', () => {
      expect(isSafeUrl('data:text/html,<h1>hi</h1>')).toBe(false);
    });

    it('rejects ftp: URLs', () => {
      expect(isSafeUrl('ftp://files.example.com')).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(isSafeUrl('not a url')).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // sanitizeOutput
  // ──────────────────────────────────────────────────────────────────────────

  describe('sanitizeOutput', () => {
    it('dispatches html format to escapeHtml', () => {
      const result = sanitizeOutput('<b>bold</b>', 'html');
      expect(result).toContain('&lt;b&gt;');
    });

    it('dispatches markdown format to sanitizeMarkdown', () => {
      const result = sanitizeOutput('<script>evil()</script>', 'markdown');
      expect(result).toBe('');
    });

    it('plain format applies both escapeHtml then sanitizeMarkdown', () => {
      const result = sanitizeOutput('<script>alert(1)</script>', 'plain');
      // escapeHtml turns < into &lt; first, so script tag is escaped not stripped
      expect(result).not.toContain('<script>');
    });

    it('defaults to plain format', () => {
      const result = sanitizeOutput('test & <value>');
      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;');
    });
  });
});
