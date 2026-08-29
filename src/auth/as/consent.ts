export interface ConsentView {
  clientName: string;
  redirectHost: string;
  loopbackOnly: boolean;
  pendingId: string;
  nonce: string;
  error?: string;
  lockedForS?: number;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] as string);
}

const CSS =
  'body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}.warn{background:#fff3cd;padding:.75rem;border-radius:.5rem}.err{color:#b00020}button{font:inherit;padding:.5rem 1rem}';

/** Full HTML document for the owner-consent screen; posts to `POST /oauth/consent`. */
export function renderConsentPage(v: ConsentView): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>brainstem-mcp — connect ${esc(v.clientName)}</title><style>${CSS}</style></head><body>
<h1>Connect <strong>${esc(v.clientName)}</strong> to your vault?</h1>
<p>This client will be able to <strong>read and write every note</strong> in your vault.</p>
<p>After you approve, the browser returns to <code>${esc(v.redirectHost)}</code>.</p>
${v.loopbackOnly ? '<p class="warn">This client only registers a <strong>loopback</strong> address (localhost). Any local process could be listening there — approve only if you just started this connection yourself.</p>' : ''}
${v.error ? `<p class="err">${esc(v.error)}</p>` : ''}
${v.lockedForS ? `<p class="err">Too many wrong attempts. Locked for ${Math.ceil(v.lockedForS / 60)} more minutes.</p>` : ''}
<form method="post" action="/oauth/consent">
<input type="hidden" name="pending_id" value="${esc(v.pendingId)}"><input type="hidden" name="nonce" value="${esc(v.nonce)}">
<label>Owner secret<br><input type="password" name="secret" autocomplete="current-password" required ${v.lockedForS ? 'disabled' : ''}></label>
<p><button name="action" value="approve" ${v.lockedForS ? 'disabled' : ''}>Approve</button> <button name="action" value="deny" formnovalidate>Deny</button></p>
</form></body></html>`;
}

/** Full HTML document for a terminal error (never redirected to, so the user isn't sent to an unverified URI). */
export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>brainstem-mcp — ${esc(title)}</title><style>${CSS}</style></head><body><h1>${esc(title)}</h1><p class="err">${esc(detail)}</p><p>Close this tab and start the connection again from Claude.</p></body></html>`;
}
