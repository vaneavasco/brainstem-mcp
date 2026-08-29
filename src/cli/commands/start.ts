export interface StartDeps {
  /**
   * `prerequisitesOnly` is decided here, not by the caller: see `runStart`.
   * The callback is responsible for loading `.env` when it is asked for the
   * full run.
   */
  doctor(opts: { prerequisitesOnly: boolean }): Promise<number>;
  hasEnv(): Promise<boolean>;
  setup(): Promise<void>;
  up(): Promise<number>;
  print(line: string): void;
}

/**
 * `./brainstem start`: prerequisites → configure on first run → start.
 *
 * `.env` is probed first, because whether it exists decides how much of doctor
 * to run. On a first run only the machine-level checks make sense
 * (`prerequisitesOnly: true` — Node/Docker/daemon/Compose), since a missing
 * `.env` must not block the run that is about to create it. Once the instance
 * IS configured, `start` runs the FULL doctor: an invalid `OWNER_SECRET`, a
 * vault path that moved or an occupied port are exactly the failures that make
 * the `up` about to follow useless, and a clear check line beats a container
 * crash loop. Either way, a failing doctor returns its code immediately without
 * touching `.env` or starting anything.
 */
export async function runStart(deps: StartDeps): Promise<number> {
  const configured = await deps.hasEnv();

  deps.print('Checking prerequisites…');
  const doctorCode = await deps.doctor({ prerequisitesOnly: !configured });
  if (doctorCode !== 0) return doctorCode;

  if (!configured) {
    deps.print("First run — let's configure brainstem");
    await deps.setup();
  }

  deps.print('Starting…');
  return deps.up();
}
