import type { ComposeRunner } from '../docker.ts';
import { type HealthInfo, waitForHealth } from '../health.ts';

export interface UpDeps {
  compose: ComposeRunner;
  env: Map<string, string>;
  print(l: string): void;
  fetchImpl: typeof fetch;
  sleep(ms: number): Promise<void>;
  localPort: number;
  /**
   * The registry tag matching the checked-out commit (`sha-<7>`), or `null`
   * when no prebuilt image can match what is on disk — see
   * `src/cli/image-tag.ts`.
   */
  imageTag(): Promise<string | null>;
}

/** Tag compose uses for a locally built image (`compose.yaml` default). */
export const LOCAL_IMAGE_TAG = 'dev';

/**
 * `build`: `true` forces a local `--build`; `false` (`--no-build`) never
 * builds — it pulls the prebuilt image, or reuses the existing local one (the
 * flag's original meaning); `undefined` pulls when it can and builds otherwise.
 */
export interface UpArgs {
  build?: boolean;
}

const HEALTH_TIMEOUT_MS = 120_000;
/** Gap between the two health polls that must agree before we print a quick-tunnel URL. */
const URL_SETTLE_DELAY_MS = 3_000;
/** How many disagreeing pairs to tolerate before printing whatever we last saw. */
const URL_SETTLE_ATTEMPTS = 10;

/** The lines `runUp` prints once the app answers healthy. */
export function upSummary(h: HealthInfo, opts: { secretHint: string }): string[] {
  const lines = [
    `Connector URL: ${h.mcpUrl}`,
    `claude mcp add --transport http brainstem ${h.mcpUrl}`,
    `Owner secret: ${opts.secretHint}`,
  ];
  if (h.tunnelMode === 'quick') {
    lines.push(
      'Note: this URL changes on every restart — see _brainstem/connection.md in your vault; ' +
        'for a stable URL run: ./brainstem setup --tunnel-token <token> --public-url https://<host>',
    );
  } else if (h.tunnelMode === 'cloudflare') {
    lines.push('URL is stable (Cloudflare named tunnel)');
  }
  return lines;
}

/**
 * Decides between the prebuilt image CI published for this commit and a local
 * build. Pulling is tried first because it turns a multi-minute first start
 * into seconds and pins the containers to exactly the commit checked out. When
 * nothing can be pulled (offline, private package, a commit CI never saw, a
 * dirty tree) the default builds; `--no-build` instead reuses the image of the
 * last local build (compose's own `--no-build` fails if there is none).
 */
async function chooseImage(
  args: UpArgs,
  deps: UpDeps,
  profile: string[],
): Promise<{ tag: string; flag: '--build' | '--no-build' | null }> {
  if (args.build === true) return { tag: LOCAL_IMAGE_TAG, flag: '--build' };
  const local = (why: string): { tag: string; flag: '--build' | '--no-build' } => {
    if (args.build === false) {
      deps.print(`${why} — reusing the existing local image`);
      return { tag: LOCAL_IMAGE_TAG, flag: '--no-build' };
    }
    deps.print(`${why} — building the image locally`);
    return { tag: LOCAL_IMAGE_TAG, flag: '--build' };
  };

  const tag = await deps.imageTag();
  if (tag === null) return local('not a clean git checkout');

  const pull = await deps.compose.run([...profile, 'pull', '--quiet'], {
    capture: true,
    env: { BRAINSTEM_IMAGE_TAG: tag },
  });
  if (pull.code === 0) return { tag, flag: null };
  return local(`no prebuilt image for ${tag}`);
}

/**
 * `docker compose up -d` (with `--profile tunnel` unless `TUNNEL_MODE=none`),
 * then waits for `/health` to answer before printing the connector summary.
 * A timeout dumps the last 20 lines of `app`/`tunnel` logs instead.
 */
export async function runUp(args: UpArgs, deps: UpDeps): Promise<number> {
  if (!(await deps.compose.available())) {
    deps.print('Docker is not running or not installed');
    return 1;
  }

  const tunnelMode = deps.env.get('TUNNEL_MODE') ?? 'none';
  const profile = tunnelMode !== 'none' ? ['--profile', 'tunnel'] : [];

  const image = await chooseImage(args, deps, profile);
  await deps.compose.run([...profile, 'up', '-d', ...(image.flag ? [image.flag] : [])], {
    env: { BRAINSTEM_IMAGE_TAG: image.tag },
  });

  let health = await waitForHealth(
    `http://localhost:${deps.localPort}/health`,
    HEALTH_TIMEOUT_MS,
    deps.fetchImpl,
    deps.sleep,
  );

  if (!health) {
    deps.print(`app did not become healthy within ${HEALTH_TIMEOUT_MS / 1000} s`);
    await deps.compose.run(['logs', '--tail', '20', 'tunnel', 'app']);
    return 1;
  }

  // A quick tunnel gets a new hostname on every start, and the app restarts
  // itself when it sees the new one — so the first healthy answer can still
  // carry the previous run's URL. Print only a URL two polls a few seconds
  // apart agree on, otherwise the owner pastes a dead connector URL into
  // Claude while the app is already booting on a different one.
  if (health.tunnelMode === 'quick') {
    for (let i = 0; i < URL_SETTLE_ATTEMPTS; i++) {
      await deps.sleep(URL_SETTLE_DELAY_MS);
      const again = await waitForHealth(
        `http://localhost:${deps.localPort}/health`,
        HEALTH_TIMEOUT_MS,
        deps.fetchImpl,
        deps.sleep,
      );
      if (!again) {
        deps.print(`app did not become healthy within ${HEALTH_TIMEOUT_MS / 1000} s`);
        await deps.compose.run(['logs', '--tail', '20', 'tunnel', 'app']);
        return 1;
      }
      const settled = again.publicUrl === health.publicUrl;
      health = again;
      if (settled) break;
    }
  }

  for (const line of upSummary(health, {
    secretHint: 'in .env (./brainstem secret show)',
  })) {
    deps.print(line);
  }
  return 0;
}
