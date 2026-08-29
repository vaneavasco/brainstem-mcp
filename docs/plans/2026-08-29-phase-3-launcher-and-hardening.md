# Phase 3′ — One-command launcher, `start`/`doctor`/`update`, help-as-docs, hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technical user clones the repo and runs ONE command — `./brainstem start` (Linux/macOS) or `brainstem start` (Windows) — which checks prerequisites, installs dependencies, runs the interactive setup on first use, starts the stack and prints how to connect Claude. `./brainstem help` is the user documentation. Plus five cheap hardening items from the Phase 2′ final review.

**Architecture:** Two ~20-line launchers at the repo root (`brainstem` bash, `brainstem.cmd` batch) do only: cd to the repo, check `node`/`docker`, `npm ci --omit=dev` when `node_modules` is missing/stale, then `exec node src/cli/brainstem.ts "$@"`. All logic stays in the TypeScript CLI (commander 15): new commands `doctor` (pre-flight with remedies), `start` (doctor → setup if no `.env` → up), `update` (git pull → npm ci → up --build in a fresh child process). A single command catalog drives both commander's registration/help and a README consistency test.

**Tech Stack:** Node 24 (native TS), commander 15.0.0, @inquirer/prompts 8.7.0, Vitest 4, Biome 2, bash, Windows batch; Docker Compose v2.

**Spec:** Owner decisions 2026-08-29 (conversation): target = owner + technical colleagues cloning from GitHub; non-technical/business users are explicitly out of scope for this phase (see `docs/reviews/2026-08-29-phase-2-final-review.md` "fix-later" and the plan v2.0 §10). Design approved in chat: launchers, `start`/`doctor`/`update`, help as documentation, README rewritten around the launcher; no auto-install of Node/Docker, no CLI-in-Docker, no interactive menu.

## Global Constraints

- Same as Phase 2′: `.ts` import extensions, `erasableSyntaxOnly`, Biome (single quotes, semicolons, trailing commas, width 100), `npm run lint:fix && npm run typecheck && npm test` clean before every commit, TDD with RED/GREEN evidence, one commit per task minimum; secrets (owner secret, tunnel token, tokens) never printed except by `secret show`.
- Commander/inquirer versions stay pinned (15.0.0 / 8.7.0); no new runtime dependencies.
- Launchers are the ONLY place shell code lives; they must not duplicate CLI logic. `brainstem.cmd` gets `text eol=crlf` in `.gitattributes`.
- Windows remains a target: paths via `path`, `spawn` without shell, `\n` line endings in files we write.
- User-facing text in English (as the rest of the project).

---

## File structure

```
brainstem                 bash launcher (executable)
brainstem.cmd             Windows launcher
.gitattributes            brainstem.cmd text eol=crlf
src/cli/catalog.ts        command catalog: name, group, summary, example (single source for help + README test)
src/cli/system.ts         SystemProbe interface + real impl (node version, docker/compose version, docker info, git, port probe)
src/cli/commands/doctor.ts
src/cli/commands/start.ts
src/cli/commands/update.ts
src/cli/brainstem.ts      registers new commands, help text from the catalog, zero-arg ⇒ help
tests/cli/doctor.test.ts, start.test.ts, update.test.ts, catalog.test.ts, launcher.test.ts, readme.test.ts
README.md                 rewritten around ./brainstem start
```

---

### Task 1: `doctor` — pre-flight checks with remedies

**Files:**
- Create: `src/cli/system.ts`, `src/cli/commands/doctor.ts`
- Modify: `src/cli/brainstem.ts` (register `doctor`)
- Test: `tests/cli/doctor.test.ts`

**Interfaces:**
```ts
// src/cli/system.ts
export interface SystemProbe {
  nodeVersion(): string;                                  // e.g. '24.13.1' (process.versions.node)
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>; // spawn, no shell, capture
  portFree(port: number): Promise<boolean>;               // net.createServer().listen(port,'127.0.0.1') probe
  platform: NodeJS.Platform;
}
export function createSystemProbe(): SystemProbe;
export function parseMajor(version: string): number;     // '24.13.1' → 24; 'v24.1.0' → 24; garbage → 0

// src/cli/commands/doctor.ts
export interface Check { name: string; ok: boolean; detail: string; remedy?: string }
export interface DoctorDeps {
  probe: SystemProbe;
  env: Map<string, string> | null;      // parsed .env or null when missing
  vaultCtx: VaultPathContext;           // from src/cli/vault-path.ts
  print(line: string): void;
}
export async function runDoctorChecks(deps: DoctorDeps): Promise<Check[]>;
export async function runDoctor(deps: DoctorDeps): Promise<number>;   // prints ✓/✗ lines + remedies; 0 iff all ok
export const REMEDIES: { node: Record<'linux' | 'darwin' | 'win32', string>; docker: Record<'linux' | 'darwin' | 'win32', string> };
```
Checks, in order: (1) Node ≥ 24 (`parseMajor(nodeVersion()) >= 24`; remedy per platform: linux `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`, darwin `brew install node@24`, win32 `winget install OpenJS.NodeJS.LTS`); (2) Docker installed (`docker --version` exit 0; remedy: Docker Desktop link `https://docs.docker.com/desktop/` on darwin/win32, `https://docs.docker.com/engine/install/` on linux); (3) Docker daemon running (`docker info` exit 0; remedy "start Docker Desktop" / "sudo systemctl start docker"); (4) Compose v2 (`docker compose version` exit 0); (5) `.env` present (remedy `./brainstem setup`); (6) if present: `OWNER_SECRET` decodes to ≥ 32 bytes (`decodeOwnerSecretBytes` from `src/config.ts`), `VAULT_PATH` passes `validateVaultPath`, `TUNNEL_MODE` ∈ {cloudflare, quick, none} and mode-consistency (`cloudflare` ⇒ `TUNNEL_TOKEN` and `PUBLIC_URL` non-empty; `quick` ⇒ `PUBLIC_URL_FILE` non-empty; `none` ⇒ `PUBLIC_URL` non-empty) — never print secret values; (7) port `PORT` (default 3000) free OR already used by our own app (`GET http://localhost:<port>/health` returns `name: 'brainstem-mcp'` — pass `fetchImpl` in deps for this; default `globalThis.fetch`). Output: `✓ Node 24.13.1`, `✗ Docker daemon — not running\n    → start Docker Desktop`. Summary line: `all checks passed` or `N check(s) failed`.

- [ ] **Step 1: Failing tests** — `tests/cli/doctor.test.ts` with a `FakeProbe` (scripted results per command):

```ts
import { describe, expect, it } from 'vitest';
import { REMEDIES, runDoctor, runDoctorChecks } from '../../src/cli/commands/doctor.ts';
import { parseMajor, type SystemProbe } from '../../src/cli/system.ts';
import { TEST_OWNER_SECRET } from '../helpers/env.ts';

function probe(over: Partial<SystemProbe> & { results?: Record<string, { code: number; stdout?: string }> } = {}): SystemProbe {
  const results = over.results ?? {};
  return {
    nodeVersion: () => '24.13.1',
    platform: 'linux',
    portFree: async () => true,
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      const r = results[key] ?? { code: 0, stdout: `${key} ok` };
      return { code: r.code, stdout: r.stdout ?? '', stderr: '' };
    },
    ...over,
  };
}
const goodEnv = () => new Map([
  ['OWNER_SECRET', TEST_OWNER_SECRET], ['VAULT_PATH', '/home/u/Vault'], ['TUNNEL_MODE', 'quick'],
  ['PUBLIC_URL_FILE', '/vault/_brainstem/public-url'], ['PORT', '3000'],
]);
const vaultCtx = { home: '/home/u', repoDir: '/proj', platform: 'linux' as const, stat: async () => ({ isDirectory: () => true }), probeWrite: async () => true };

describe('parseMajor', () => {
  it('parses major versions', () => {
    expect(parseMajor('24.13.1')).toBe(24); expect(parseMajor('v22.0.0')).toBe(22); expect(parseMajor('nope')).toBe(0);
  });
});

describe('runDoctorChecks', () => {
  it('passes on a healthy machine with a valid .env', async () => {
    const checks = await runDoctorChecks({ probe: probe(), env: goodEnv(), vaultCtx, print() {} });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(['node', 'docker', 'docker-daemon', 'compose', 'env', 'owner-secret', 'vault-path', 'tunnel-mode', 'port']);
  });
  it('flags an old Node with the platform remedy', async () => {
    const checks = await runDoctorChecks({ probe: probe({ nodeVersion: () => '20.1.0', platform: 'darwin' }), env: goodEnv(), vaultCtx, print() {} });
    const node = checks.find((c) => c.name === 'node');
    expect(node?.ok).toBe(false); expect(node?.remedy).toBe(REMEDIES.node.darwin);
  });
  it('distinguishes docker missing from docker not running', async () => {
    const missing = await runDoctorChecks({ probe: probe({ results: { 'docker --version': { code: 127 } } }), env: goodEnv(), vaultCtx, print() {} });
    expect(missing.find((c) => c.name === 'docker')?.ok).toBe(false);
    const stopped = await runDoctorChecks({ probe: probe({ results: { 'docker info': { code: 1 } } }), env: goodEnv(), vaultCtx, print() {} });
    expect(stopped.find((c) => c.name === 'docker')?.ok).toBe(true);
    expect(stopped.find((c) => c.name === 'docker-daemon')?.remedy).toMatch(/systemctl start docker/);
  });
  it('reports a missing .env with the setup remedy and skips env-derived checks', async () => {
    const checks = await runDoctorChecks({ probe: probe(), env: null, vaultCtx, print() {} });
    expect(checks.find((c) => c.name === 'env')).toMatchObject({ ok: false, remedy: './brainstem setup' });
    expect(checks.some((c) => c.name === 'owner-secret')).toBe(false);
  });
  it('validates the secret, vault path and tunnel-mode consistency without printing secrets', async () => {
    const env = goodEnv(); env.set('OWNER_SECRET', 'short'); env.set('TUNNEL_MODE', 'cloudflare'); env.set('TUNNEL_TOKEN', 'tok-VALUE');
    const lines: string[] = [];
    const code = await runDoctor({ probe: probe(), env, vaultCtx, print: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/OWNER_SECRET/); expect(lines.join('\n')).not.toContain('short');
    expect(lines.join('\n')).toMatch(/PUBLIC_URL/); expect(lines.join('\n')).not.toContain('tok-VALUE');
  });
  it('treats a port used by our own app as fine', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ status: 'ok', name: 'brainstem-mcp' }), { status: 200 });
    const checks = await runDoctorChecks({ probe: probe({ portFree: async () => false }), env: goodEnv(), vaultCtx, print() {}, fetchImpl } as never);
    expect(checks.find((c) => c.name === 'port')).toMatchObject({ ok: true });
  });
});
```
(Add `fetchImpl?: typeof fetch` to `DoctorDeps` so the last test needs no cast.)

- [ ] **Step 2: Run** `npx vitest run tests/cli/doctor.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** `system.ts` (`exec` via `spawn(cmd, args, { stdio: 'pipe', shell: false })`, resolve `{ code: 127 }` on `ENOENT` spawn error; `portFree` via `net.createServer().once('error', …).listen(port, '127.0.0.1', close)`), `doctor.ts` per the check list, register in `brainstem.ts`:
```ts
program.command('doctor').description('Check prerequisites and configuration; print how to fix what is missing')
  .action(() => runAction(() => runDoctor({ probe: createSystemProbe(), env: loadEnvMapOrNull(), vaultCtx: createVaultCtx(repoDir), print: console.log })));
```
(`loadEnvMapOrNull` = existing `.env` loader returning `null` when the file is absent — refactor the existing loader if it throws today.)
- [ ] **Step 4: Run tests, lint, typecheck** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): doctor — prerequisite and configuration checks with remedies"`

---

### Task 2: `start` and `update`, command catalog, help as documentation

**Files:**
- Create: `src/cli/catalog.ts`, `src/cli/commands/start.ts`, `src/cli/commands/update.ts`
- Modify: `src/cli/brainstem.ts` (descriptions from the catalog, `addHelpText`, zero-arg ⇒ help, `help [command]`)
- Test: `tests/cli/catalog.test.ts`, `tests/cli/start.test.ts`, `tests/cli/update.test.ts`

**Interfaces:**
```ts
// catalog.ts
export type CommandGroup = 'Everyday' | 'Configuration' | 'Maintenance';
export interface CommandInfo { name: string; group: CommandGroup; summary: string; example: string }
export const COMMANDS: readonly CommandInfo[];   // start, up, down, status, url, logs | setup, secret | update, doctor, revoke-all
export function renderHelpText(): string;         // "Recommended flow" (3 lines) + grouped table used by addHelpText('after')
// start.ts
export interface StartDeps { doctor: () => Promise<number>; hasEnv: () => Promise<boolean>; setup: () => Promise<void>; up: () => Promise<number>; print(line: string): void }
export async function runStart(deps: StartDeps): Promise<number>;   // doctor (env checks tolerate a missing .env: only prerequisites must pass) → setup if !hasEnv → up
// update.ts
export interface UpdateDeps { exec: SystemProbe['exec']; run(cmd: string, args: string[]): Promise<number>; print(line: string): void }
export async function runUpdate(deps: UpdateDeps): Promise<number>;  // git pull --ff-only → npm ci --omit=dev → child `node src/cli/brainstem.ts up --build`; prints old..new short SHAs
```
`runStart` semantics: `doctorPrereqs()` = the doctor's checks 1–4 only (Node/Docker/daemon/Compose) — give `runDoctorChecks` an option `{ prerequisitesOnly: true }`; if any fails print them and return 1. Then `if (!(await hasEnv())) await setup()`. Then `return up()`. `runUpdate`: `git rev-parse --short HEAD` before/after, `git pull --ff-only` (non-zero ⇒ print "local changes or diverged history — run git status" and return 1), `npm ci --omit=dev` via `run`, then `run('node', ['src/cli/brainstem.ts', 'up', '--build'])` in a child so freshly installed modules are used.

- [ ] **Step 1: Failing tests**
```ts
// catalog.test.ts
it('every registered commander command has a catalog entry and vice versa', async () => {
  const { buildProgram } = await import('../../src/cli/brainstem.ts');   // export buildProgram if not already exported
  const names = buildProgram().commands.map((c) => c.name()).filter((n) => n !== 'help');
  expect(new Set(names)).toEqual(new Set(COMMANDS.map((c) => c.name)));
});
it('renderHelpText lists the recommended flow first and groups commands', () => {
  const text = renderHelpText();
  expect(text.indexOf('Recommended flow')).toBeLessThan(text.indexOf('Everyday'));
  for (const g of ['Everyday', 'Configuration', 'Maintenance']) expect(text).toContain(g);
  expect(text).toContain('./brainstem start');
});
// start.test.ts
it('runs setup only when .env is missing, then up', async () => {
  const calls: string[] = [];
  const code = await runStart({ doctor: async () => { calls.push('doctor'); return 0; }, hasEnv: async () => false, setup: async () => { calls.push('setup'); }, up: async () => { calls.push('up'); return 0; }, print() {} });
  expect(code).toBe(0); expect(calls).toEqual(['doctor', 'setup', 'up']);
  const calls2: string[] = [];
  await runStart({ doctor: async () => 0, hasEnv: async () => true, setup: async () => { calls2.push('setup'); }, up: async () => { calls2.push('up'); return 0; }, print() {} });
  expect(calls2).toEqual(['up']);
});
it('stops when prerequisites fail', async () => {
  const code = await runStart({ doctor: async () => 1, hasEnv: async () => false, setup: async () => { throw new Error('must not run'); }, up: async () => 0, print() {} });
  expect(code).toBe(1);
});
// update.test.ts
it('pulls, installs and restarts in a child process', async () => {
  const ran: string[] = []; let sha = 'aaa1111';
  const code = await runUpdate({
    exec: async (cmd, args) => { const k = [cmd, ...args].join(' '); if (k === 'git rev-parse --short HEAD') return { code: 0, stdout: `${sha}\n`, stderr: '' }; if (k === 'git pull --ff-only') { sha = 'bbb2222'; return { code: 0, stdout: '', stderr: '' }; } return { code: 0, stdout: '', stderr: '' }; },
    run: async (cmd, args) => { ran.push([cmd, ...args].join(' ')); return 0; },
    print() {},
  });
  expect(code).toBe(0);
  expect(ran).toEqual(['npm ci --omit=dev', 'node src/cli/brainstem.ts up --build']);
});
it('refuses to update over local changes', async () => {
  const code = await runUpdate({ exec: async (cmd, args) => ({ code: args[0] === 'pull' ? 1 : 0, stdout: 'abc1234\n', stderr: 'diverged' }), run: async () => 0, print() {} });
  expect(code).toBe(1);
});
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; in `brainstem.ts`: `program.description(...)`, each `.command(name).description(COMMANDS.find(...).summary)`, `program.addHelpText('after', renderHelpText())`, `program.showHelpAfterError()`, and `if (process.argv.length <= 2) program.outputHelp()` before `parseAsync`; `help [command]` is commander's built-in — keep it. `start`: `.option('--vault <path>')`/`--tunnel-token`/`--public-url` passed through to `setup` when it runs.
- [ ] **Step 4: Run tests, lint, typecheck** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): start and update commands; command catalog drives help"`

---

### Task 3: Launchers `./brainstem` and `brainstem.cmd`

**Files:**
- Create: `brainstem` (mode 755), `brainstem.cmd`, `.gitattributes`
- Test: `tests/cli/launcher.test.ts`

`brainstem` (bash):
```bash
#!/usr/bin/env bash
# brainstem — one-command launcher. All logic lives in src/cli/brainstem.ts; this only
# makes sure node + docker exist and dependencies are installed, then delegates.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 is required. Install: https://nodejs.org/en/download (Linux: NodeSource setup_24.x; macOS: brew install node@24)" >&2; exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then echo "Node.js $major found; version 24 or newer is required." >&2; exit 1; fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Desktop (https://docs.docker.com/desktop/) or Docker Engine + Compose v2." >&2; exit 1
fi
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies…" >&2
  npm ci --omit=dev --silent --no-audit --no-fund
fi
exec node src/cli/brainstem.ts "$@"
```
`brainstem.cmd` (batch, CRLF):
```bat
@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24 is required. Install: winget install OpenJS.NodeJS.LTS & exit /b 1)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set MAJOR=%%v
if %MAJOR% LSS 24 (echo Node.js %MAJOR% found; version 24 or newer is required. & exit /b 1)
where docker >nul 2>nul || (echo Docker Desktop is required: https://docs.docker.com/desktop/ & exit /b 1)
if not exist node_modules\.package-lock.json (
  echo Installing dependencies...
  call npm ci --omit=dev --silent --no-audit --no-fund || exit /b 1
)
node src\cli\brainstem.ts %*
exit /b %ERRORLEVEL%
```
`.gitattributes`: `brainstem.cmd text eol=crlf` and `brainstem text eol=lf`.

- [ ] **Step 1: Failing test** — `tests/cli/launcher.test.ts` (skipped on win32): spawn `bash ./brainstem help` from the repo root with `stdio: 'pipe'` and a 60 s timeout; assert exit 0 and stdout contains `Recommended flow` and `start`; also assert `fs.statSync('brainstem').mode & 0o111` is non-zero; also run `bash -n brainstem` (syntax check) exit 0; and assert `brainstem.cmd` contains `\r\n` line endings and `src\cli\brainstem.ts`.
- [ ] **Step 2: Run** → FAIL (files missing).
- [ ] **Step 3: Create the files**; `chmod +x brainstem`; `git add --chmod=+x brainstem` (so the bit is tracked).
- [ ] **Step 4: Run tests, lint, typecheck; manual: `./brainstem help`, `./brainstem doctor`.** PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: ./brainstem and brainstem.cmd launchers (checks node/docker, installs deps, delegates to the CLI)"`

---

### Task 4: README rewritten around the launcher; README ↔ catalog consistency test

**Files:**
- Modify: `README.md`, `docs/plans/README.md` (Phase 3′ row), `package.json` (`"bin": { "brainstem": "./brainstem" }` is NOT added — the launcher is a repo script, not an npm bin)
- Test: `tests/cli/readme.test.ts`

README structure: *What it is* (unchanged) · *Requirements* (Docker Desktop/Engine + Compose v2; Node 24; git) · **Quick start**: `git clone … && cd brainstem-mcp && ./brainstem start` (Windows: `brainstem start`), what `start` does (checks → asks vault + tunnel → starts → prints the connector URL) · *Connect Claude* (unchanged content) · *Commands* — table generated from the catalog groups (`./brainstem <name>` — summary — example) · *Stable URL* / *Quick tunnel caveat* / *Vault sync notes* / *Security model* / *Troubleshooting* (unchanged, `npm run …` replaced by `./brainstem …`) · **For developers**: `npm install`, `npm test`, `npm run dev`, `npm run brainstem -- <cmd>` (the launcher is a thin wrapper around this), Docker smoke.

- [ ] **Step 1: Failing test** — `tests/cli/readme.test.ts`: read `README.md`; for every catalog command assert `./brainstem <name>` appears; assert `./brainstem start` appears before `npm install` (quick start first); assert no line contains `npm run setup` or `npm run up` outside the "For developers" section.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Rewrite README**; add the Phase 3′ row to `docs/plans/README.md`.
- [ ] **Step 4: Run tests, lint** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "docs: README around ./brainstem start; catalog consistency test"`

---

### Task 5: Hardening wave (five fix-later items from the Phase 2′ final review)

**Files:**
- Modify: `src/cli/env-file.ts` + `tests/cli/env-file.test.ts`; `.github/workflows/ci.yml`; `src/app.ts` + `src/auth/mount.ts` + `tests/auth/oauth-rs.test.ts`; `src/auth/as/net.ts` + `tests/auth/cimd.test.ts`; `compose.yaml` + `.env.example` + `README.md` (env section)

1. **`.env` quoting**: quote values containing `$` as well (single-quote form); for values containing `'`, emit the single-quote form with `'\''` splicing instead of the double-quote fallback (compose-go and Node both read it literally); `parseEnv` handles the spliced form. Tests: `A='it'\''s'` round-trips; `$HOME`-like values are single-quoted and round-trip.
2. **CI docker smoke job**: add a second job `docker-smoke` (`runs-on: ubuntu-latest`, `needs: verify`): checkout, `node -e` to generate `OWNER_SECRET`, write `.env` (`TUNNEL_MODE=none`, `PUBLIC_URL=http://localhost:3000`, `ALLOW_INSECURE_PUBLIC_URL=true`, `VAULT_PATH=$GITHUB_WORKSPACE/vault-dev`, `HOST_UID=$(id -u)`, `HOST_GID=$(id -g)`), `mkdir -p vault-dev`, `docker compose up -d --build`, `bash scripts/docker-smoke.sh`, `docker compose logs app` on failure (`if: failure()`), `docker compose down`.
3. **Unauthenticated `/mcp` bucket**: in `src/app.ts` put a small separate limiter (`capacity: 20, refillPerSec: 5`) BEFORE `bearerGate` for requests WITHOUT an `Authorization` header only (a tiny middleware that skips when the header is present), and move the main 60/60 limiter AFTER `bearerGate`. Test: 25 rapid unauthenticated POSTs ⇒ some 429; authenticated requests unaffected by the unauth bucket.
4. **CIMD overall deadline**: in `fetchClientMetadataDocument` add a `setTimeout(timeoutMs)` that destroys the request (`req.destroy(new Error('timeout fetching client metadata'))`) regardless of socket activity; clear it on settle. Test: a server that drips one byte every 100 ms ⇒ rejects within ~timeoutMs (use `timeoutMs: 300` in the test).
5. **Compose env passthrough**: add `DAILY_NOTES_TEMPLATE: ${DAILY_NOTES_TEMPLATE:-}`, `REQUIRED_FRONTMATTER: ${REQUIRED_FRONTMATTER:-}` to `compose.yaml`'s `app.environment` and the two keys (empty) to `.env.example` with one-line comments; `STATE_DIR` stays test-only (document in `.env.example` comment that it is not supported under Docker). Verify `docker compose config` locally.

- [ ] Steps: failing tests for 1, 3, 4 → implement all five → `npm test`, lint, typecheck, `docker compose config` with a throwaway `.env` → commit `git commit -m "fix: env quoting for \$ and quotes; unauth /mcp bucket; CIMD overall deadline; compose env passthrough; docker-smoke CI job"` (the CI job is verified by the next push to main — check `gh run watch`).

---

## Acceptance log

**Status: complete 2026-08-29** — Tasks 1–5 plus the final-review fix wave (F1–F6, M7–M10, M13–M14; see `.superpowers/sdd/2026-08-29-phase-3-launcher-and-hardening/final-fix-wave-report.md`).

### Automated evidence

- `npm test` — **337 passed, 7 skipped (344), 44 files** on the fix-wave branch (`326 passed / 333` at Task 5 exit, cff0f8c). `npm run lint` (Biome, 116 files) and `npm run typecheck` (tsc, no emit) both clean.
- Launcher coverage — `tests/cli/launcher.test.ts`, **13 tests**: bash syntax (`bash -n`), the executable bit, an end-to-end `bash ./brainstem help` that reaches the real CLI and prints the catalog, the missing-node path, the CRLF/entrypoint shape of `brainstem.cmd`, five cases for the shared dependency-staleness one-liner, and three structural assertions on the install branch (no `--omit=dev` over a dev install, no `--silent`, README documents `BRAINSTEM_SKIP_INSTALL`). The install branch is asserted on the script *text*, not executed: running it would `npm ci` over the suite's own `node_modules` mid-run.
- CI on cff0f8c (run [33274064468](https://github.com/vaneavasco/brainstem-mcp/actions/runs/33274064468)): `verify` **success**, `docker-smoke` **success** — the Task 5 job that builds the image, brings the Compose stack up and runs `scripts/docker-smoke.sh` against it.
- Manual, on Linux: `./brainstem help`, `./brainstem help secret` (subcommand list intact after the built-in list was hidden), `./brainstem status` / `./brainstem secret show` with no `.env` (both now print ``.env not found — run `./brainstem setup` first``).

### Owner-run, still pending

These need machines this session does not have; none of them is covered by any test:

- [ ] **Windows**: `.\brainstem start` end to end on a real Windows box, and specifically `.\brainstem update` — the `shell: true` + quoted-`process.execPath` spawn path (F1) and the `if exist node_modules\.bin\vitest` branch in `brainstem.cmd` (F4) have never executed under cmd.exe.
- [ ] **macOS**: `./brainstem start` on a mac — the launcher avoids `readlink -f` for BSD's sake, but that is argued, not observed.
- [ ] **First run on a clean clone**: `git clone && cd && ./brainstem start` with no `node_modules` at all, so the install branch (now `npm ci --omit=dev … --loglevel=error`) runs for real, followed by setup's prompts and a healthy stack.

### Fix-later (carried forward, none blocking)

- **The launcher's negative-PATH test passes by accident.** `tests/cli/launcher.test.ts` sets `PATH=/nonexistent` and asserts "Node.js 24 is required" — but `spawn` is given the launcher's own directory-relative path, and the message it gets comes from `command -v node` failing, which would also happen for reasons the test does not distinguish. It proves the branch is reachable, not that it is reached for the right reason.
- **The launcher test needs a `docker` binary on PATH** to get past the prerequisite check and reach the delegation assertion; on a machine without Docker it fails for an unrelated reason instead of skipping.
- **Non-TTY `start` cannot choose a tunnel mode.** `--tunnel-token`/`--public-url` select `cloudflare`, but there is no `--tunnel-mode` flag, so `quick` and `none` are unreachable without a TTY — CI and container-driven first runs have no way to ask for them.
- **`.gitattributes` normalization**: `* text=auto` and `*.sh text eol=lf` were added in the fix wave alongside the two existing per-launcher rules; a checkout made before that on a CRLF-defaulting Windows client can still hold `scripts/docker-smoke.sh` with CRLF endings (`git add --renormalize .` fixes such a clone).
