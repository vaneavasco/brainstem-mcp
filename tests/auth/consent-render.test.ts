import { describe, expect, it } from 'vitest';
import { type ConsentView, renderConsentPage, renderErrorPage } from '../../src/auth/as/consent.ts';

const view = (over: Partial<ConsentView> = {}): ConsentView => ({
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  loopbackOnly: false,
  pendingId: 'pending-123',
  nonce: 'nonce-456',
  ...over,
});

/** Everything between every <style> … </style> pair, concatenated. */
function styleText(html: string): string {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '').join('\n');
}

describe('renderConsentPage', () => {
  it('keeps the form contract the browser and the CLI both depend on', () => {
    const html = renderConsentPage(view());
    expect(html).toContain('<form method="post" action="/oauth/consent"');
    expect(html).toContain('name="pending_id" value="pending-123"');
    expect(html).toContain('name="nonce" value="nonce-456"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="secret"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('inputmode="text"');
    expect(html).toContain('spellcheck="false"');
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="deny"');
    expect(html).toContain('formnovalidate');
    // The secret field has a real, clickable <label for=…> (keyboard + tap target).
    expect(html).toMatch(/<label[^>]+for="secret"/);
    expect(html).toMatch(/<input id="secret"/);
  });

  it('shows the client name in <strong>, the redirect host and the permission list', () => {
    const html = renderConsentPage(view());
    expect(html).toContain('<strong>Claude</strong>');
    expect(html).toContain('claude.ai');
    expect(html).toMatch(/read/i);
    expect(html).toMatch(/\.trash\//);
    expect(html).toMatch(/Owner secret lives in/);
  });

  it('escapes a hostile client name and redirect host', () => {
    const html = renderConsentPage(
      view({ clientName: '<script>alert(1)</script>', redirectHost: 'evil"host' }),
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('evil&quot;host');
  });

  it('warns when the client only registers loopback redirects', () => {
    expect(renderConsentPage(view({ loopbackOnly: true }))).toMatch(/loopback|local process/i);
    expect(renderConsentPage(view({ loopbackOnly: false }))).not.toMatch(/loopback/i);
  });

  it('renders a wrong-secret error as an alert', () => {
    const html = renderConsentPage(view({ error: 'Incorrect secret. Try again.' }));
    expect(html).toContain('Incorrect secret. Try again.');
    expect(html).toContain('role="alert"');
    // Still usable: only the locked state disables the inputs.
    expect(html).not.toMatch(/<(?:input|button)[^>]*\sdisabled/);
  });

  it('uses the singular for one remaining minute and the plural beyond it', () => {
    expect(renderConsentPage(view({ lockedForS: 30 }))).toContain('1 minute');
    expect(renderConsentPage(view({ lockedForS: 30 }))).not.toContain('1 minutes');
    expect(renderConsentPage(view({ lockedForS: 60 }))).toContain('1 minute');
    expect(renderConsentPage(view({ lockedForS: 61 }))).toContain('2 minutes');
    expect(renderConsentPage(view({ lockedForS: 120 }))).toContain('2 minutes');
  });

  it('locks the secret field and the approve button while locked out', () => {
    const html = renderConsentPage(view({ lockedForS: 120 }));
    expect(html).toMatch(/locked/i);
    expect(html).toMatch(/<input id="secret"[^>]*\sdisabled/);
    expect(html).toMatch(/name="action" value="approve"[^>]*\sdisabled/);
  });

  it('styles itself for a phone and for both colour schemes, with no external resources', () => {
    const html = renderConsentPage(view({ loopbackOnly: true, error: 'x' }));
    const css = styleText(html);
    expect(css).toContain('color-scheme: light dark');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('max-width');
    // No script anywhere, and nothing the browser would have to fetch.
    expect(html).not.toContain('<script');
    expect(css).not.toMatch(/https?:/);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/<(?:img|link|iframe|object|embed)\b/i);
  });
});

describe('renderErrorPage', () => {
  it('shows the escaped title and detail plus the recovery hint', () => {
    const html = renderErrorPage('Session <expired>', 'Start again & be quick');
    expect(html).toContain('Session &lt;expired&gt;');
    expect(html).toContain('Start again &amp; be quick');
    expect(html).not.toContain('<expired>');
    expect(html).toContain('Close this tab and start the connection again from Claude.');
  });

  it('carries the same card styling and no external resources', () => {
    const html = renderErrorPage('Unknown client', 'nope');
    const css = styleText(html);
    expect(css).toContain('prefers-color-scheme: dark');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/i);
  });
});
