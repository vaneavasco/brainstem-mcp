import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ConnectionInfo {
  publicUrl: string;
  mcpUrl: string;
  tunnelMode: string;
  updatedAt: string;
}

export interface InstanceInfo {
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
}

const OTHER_HOST_STALE_MS = 5 * 60_000;

/**
 * Atomic tmp-write + rename, same pattern as `src/auth/store/file-store.ts`'s
 * `writeAtomic`: a unique per-write tmp name (pid + random suffix) so this
 * process and any future short-lived CLI touching the same file can't race
 * each other's rename with a shared `<file>.tmp` name.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * Renders the note the owner reads in Obsidian (synced to the phone) to
 * reconnect Claude to this brainstem instance after the quick-tunnel URL
 * changes. Frontmatter first so Obsidian/Dataview can find it by `type`.
 */
export function renderConnectionNote(info: ConnectionInfo): string {
  return `---
type: brainstem-connection
mode: ${info.tunnelMode}
updatedAt: ${info.updatedAt}
---
# brainstem-mcp connection

**Connector URL:** \`${info.mcpUrl}\`

## claude.ai / Claude mobile
1. Settings → Connectors → *Add custom connector* → paste the URL above → Add.
2. Click *Connect*, type your owner secret (in \`.env\` on the machine that runs brainstem) → Approve.
3. If this URL changed (quick tunnel restart): *remove* the old connector first, then *add* the new URL.

## Claude Code
\`claude mcp add --transport http brainstem ${info.mcpUrl}\` then \`/mcp\` → Authenticate.
(After a URL change: \`claude mcp remove brainstem\` and add again.)
`;
}

export async function writeConnectionNote(stateDir: string, info: ConnectionInfo): Promise<void> {
  await writeAtomic(path.join(stateDir, 'connection.md'), renderConnectionNote(info));
}

async function readInstanceFile(file: string): Promise<InstanceInfo | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Partial<InstanceInfo>).hostname === 'string' &&
      typeof (parsed as Partial<InstanceInfo>).heartbeatAt === 'string' &&
      typeof (parsed as Partial<InstanceInfo>).startedAt === 'string'
    ) {
      return parsed as InstanceInfo;
    }
    return null;
  } catch {
    // Corrupt JSON (partial write, sync conflict, hand edit) — treat as absent.
    return null;
  }
}

/**
 * Records this process's identity + heartbeat at `<stateDir>/instance.json`,
 * so two brainstem processes pointed at the same synced vault (e.g. a laptop
 * and a desktop both syncing the same Obsidian vault) can tell they're
 * stepping on each other.
 *
 * `otherHost` is the *previous* file's hostname when it differs from ours and
 * its heartbeat still looks alive. "Still alive" is judged against `now()`
 * (real wall-clock time by default, injectable for tests) — deliberately
 * NOT against the incoming `info.heartbeatAt` we are about to write, because
 * that value is caller-supplied and may be clock-skewed (e.g. NTP correction)
 * without that saying anything about whether the *other* host is still up.
 */
export async function writeInstanceFile(
  stateDir: string,
  info: InstanceInfo,
  now: () => number = Date.now,
): Promise<{ otherHost: string | null }> {
  const file = path.join(stateDir, 'instance.json');
  const existing = await readInstanceFile(file);
  const otherHost =
    existing &&
    existing.hostname !== info.hostname &&
    now() - Date.parse(existing.heartbeatAt) < OTHER_HOST_STALE_MS
      ? existing.hostname
      : null;
  await writeAtomic(file, `${JSON.stringify(info, null, 2)}\n`);
  return { otherHost };
}
