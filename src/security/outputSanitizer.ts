/**
 * Output Sanitizer
 *
 * Sanitizes agent outputs to prevent XSS, injection attacks, and malicious content
 * in HTML, Markdown, and plain text outputs.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

/**
 * Escape HTML entities to prevent XSS attacks.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, ch => HTML_ENTITIES[ch]);
}

/**
 * Sanitize Markdown content by stripping dangerous elements.
 * Removes script tags, event handlers, javascript: and data: URLs, and embedded objects.
 */
export function sanitizeMarkdown(input: string): string {
  let result = input;

  // Strip script tags
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // Strip event handlers (onclick, onload, etc.)
  result = result.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '');

  // Strip javascript: and data: URLs
  result = result.replace(/\b(javascript|data)\s*:/gi, 'blocked:');

  // Strip iframe/object/embed tags (both paired and self-closing)
  result = result.replace(/<(iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  result = result.replace(/<(iframe|object|embed)\b[^>]*\/?>/gi, '');

  return result;
}

/**
 * Validate that a URL uses a safe protocol (http or https).
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Sanitize output content based on format.
 *
 * @param content - The content to sanitize
 * @param format - Output format: 'html', 'markdown', or 'plain'
 * @returns Sanitized content safe for the specified format
 */
export function sanitizeOutput(
  content: string,
  format: 'html' | 'markdown' | 'plain' = 'plain'
): string {
  switch (format) {
    case 'html':
      return escapeHtml(content);
    case 'markdown':
      return sanitizeMarkdown(content);
    case 'plain':
      return sanitizeMarkdown(escapeHtml(content));
  }
}
