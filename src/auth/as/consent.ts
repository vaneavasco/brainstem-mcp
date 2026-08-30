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

/**
 * Every byte of this page is inline. The response CSP is
 * `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' <redirect-origin>`,
 * so no script, stylesheet, font or image may be fetched — not even from our own
 * origin. The mark is therefore inline `<svg>` markup (markup, not an image request,
 * so it needs no CSP change) and the type is a system font stack. Claude opens this
 * page in an in-app browser on a phone, so the layout is one centred card that fits a
 * narrow viewport, with >=44px tap targets and visible focus rings for keyboard use.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --bg: #eef0f4;
  --card: #ffffff;
  --fg: #16181d;
  --muted: #5a6472;
  --line: #dfe3ea;
  --field: #fbfcfd;
  --accent: #3355d1;
  --accent-fg: #ffffff;
  --accent-hover: #2a47b4;
  --note-bg: #fff7e0;
  --note-line: #e7c565;
  --note-fg: #6a4c00;
  --alert-bg: #fdeaee;
  --alert-line: #e3959f;
  --alert-fg: #8c1b2c;
  --chip: #eef1f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d0f13;
    --card: #171a21;
    --fg: #e9ebef;
    --muted: #a2aab8;
    --line: #272c36;
    --field: #12151b;
    --accent: #8098fa;
    --accent-fg: #0d0f13;
    --accent-hover: #9aadfb;
    --note-bg: #2a2413;
    --note-line: #6b5a20;
    --note-fg: #f2dc94;
    --alert-bg: #2c1419;
    --alert-line: #7c2c37;
    --alert-fg: #f4b5bd;
    --chip: #1f242d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1.5rem 1rem 2.5rem;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.card {
  width: 100%;
  max-width: 28rem;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 1.75rem 1.5rem;
  box-shadow: 0 1px 2px rgba(15, 20, 35, .06), 0 14px 36px rgba(15, 20, 35, .10);
}
.brand {
  display: flex;
  align-items: center;
  gap: .5rem;
  color: var(--muted);
  font-size: .8125rem;
  font-weight: 600;
}
.brand svg { display: block; flex: none; color: var(--accent); }
h1 {
  margin: 1.125rem 0 .625rem;
  font-size: 1.375rem;
  line-height: 1.3;
  font-weight: 650;
  letter-spacing: -.01em;
}
p { margin: 0 0 .875rem; }
.muted { color: var(--muted); font-size: .9375rem; }
.perms {
  margin: 0 0 1rem;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.perms li {
  display: flex;
  gap: .625rem;
  align-items: baseline;
  padding: .625rem .875rem;
  border-top: 1px solid var(--line);
  font-size: .9375rem;
}
.perms li:first-child { border-top: 0; }
.perms li::before {
  content: "";
  flex: none;
  width: .4375rem;
  height: .4375rem;
  border-radius: 50%;
  background: var(--accent);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .875em;
  background: var(--chip);
  padding: .1em .35em;
  border-radius: 6px;
  word-break: break-all;
}
.note, .alert {
  margin: 0 0 1rem;
  padding: .75rem .875rem;
  border: 1px solid;
  border-radius: 12px;
  font-size: .9375rem;
}
.note { background: var(--note-bg); border-color: var(--note-line); color: var(--note-fg); }
.alert { background: var(--alert-bg); border-color: var(--alert-line); color: var(--alert-fg); }
.note code, .alert code { background: rgba(127, 127, 127, .18); }
label { display: block; font-weight: 600; font-size: .9375rem; margin-bottom: .375rem; }
input[type="password"] {
  width: 100%;
  min-height: 2.875rem;
  padding: .75rem .875rem;
  font: inherit;
  color: var(--fg);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.actions { display: flex; flex-wrap: wrap; gap: .625rem; margin-top: 1.125rem; }
button {
  flex: 1 1 100%;
  min-height: 2.875rem;
  padding: .75rem 1.25rem;
  font: inherit;
  font-weight: 600;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
}
.approve { background: var(--accent); color: var(--accent-fg); }
.deny { background: transparent; color: var(--fg); border-color: var(--line); }
@media (hover: hover) {
  .approve:hover { background: var(--accent-hover); }
  .deny:hover { border-color: var(--muted); }
}
@media (min-width: 26rem) {
  .actions { flex-wrap: nowrap; }
  .approve { flex: 2 1 0; }
  .deny { flex: 1 1 0; }
}
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
input[type="password"]:disabled, button:disabled { opacity: .55; cursor: not-allowed; }
.foot {
  margin: 1.25rem 0 0;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: .8125rem;
}
`;

/**
 * Three linked nodes over a stem — inline markup, so it costs no request under
 * `default-src 'none'`, and it inherits the surrounding colour in both themes.
 */
const MARK =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 7.2v4.1m0 0-4.6 2.9m4.6-2.9 4.6 2.9M12 16.6v2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="4.6" r="2.6" fill="currentColor"/><circle cx="6.2" cy="14.6" r="2.6" fill="currentColor"/><circle cx="17.8" cy="14.6" r="2.6" fill="currentColor"/><circle cx="12" cy="20.6" r="1.5" fill="currentColor"/></svg>';

function head(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><main class="card"><div class="brand">${MARK}<span>brainstem-mcp</span></div>`;
}

const FOOT = '</main></body></html>';

/** "1 minute", "2 minutes" — never the "1 minutes" the first cut of this page shipped. */
function minutesLeft(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** Full HTML document for the owner-consent screen; posts to `POST /oauth/consent`. */
export function renderConsentPage(v: ConsentView): string {
  const locked = Boolean(v.lockedForS);
  const disabled = locked ? ' disabled' : '';
  return `${head(`brainstem-mcp — connect ${esc(v.clientName)}`)}
<h1>Connect <strong>${esc(v.clientName)}</strong> to your vault?</h1>
<p class="muted">Approving lets this client work with every note in your vault:</p>
<ul class="perms">
<li>Read any note, folder or attachment</li>
<li>Write: create notes and edit existing ones</li>
<li>Delete only by moving to <code>.trash/</code> — nothing is erased outright</li>
</ul>
<p class="muted">After you approve, the browser returns to <code>${esc(v.redirectHost)}</code>.</p>
${v.loopbackOnly ? '<p class="note">This client only registers a <strong>loopback</strong> address (localhost). Any local process could be listening there — approve only if you just started this connection yourself.</p>' : ''}
${v.error ? `<p class="alert" role="alert">${esc(v.error)}</p>` : ''}
${locked ? `<p class="alert" role="alert">Too many wrong attempts. Locked — try again in ${minutesLeft(v.lockedForS as number)}.</p>` : ''}
<form method="post" action="/oauth/consent">
<input type="hidden" name="pending_id" value="${esc(v.pendingId)}"><input type="hidden" name="nonce" value="${esc(v.nonce)}">
<label for="secret">Owner secret</label>
<input id="secret" type="password" name="secret" autocomplete="current-password" inputmode="text" spellcheck="false" autocapitalize="off" required${disabled}>
<div class="actions">
<button class="approve" name="action" value="approve"${disabled}>Approve</button>
<button class="deny" name="action" value="deny" formnovalidate>Deny</button>
</div>
</form>
<p class="foot">Owner secret lives in <code>.env</code> on the machine running brainstem.</p>
${FOOT}`;
}

/** Full HTML document for a terminal error (never redirected to, so the user isn't sent to an unverified URI). */
export function renderErrorPage(title: string, detail: string): string {
  return `${head(`brainstem-mcp — ${esc(title)}`)}
<h1>${esc(title)}</h1>
<p class="alert" role="alert">${esc(detail)}</p>
<p class="muted">Close this tab and start the connection again from Claude.</p>
${FOOT}`;
}
