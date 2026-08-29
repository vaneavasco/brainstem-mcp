export interface StartDeps {
  doctor(): Promise<number>;
  hasEnv(): Promise<boolean>;
  setup(): Promise<void>;
  up(): Promise<number>;
  print(line: string): void;
}

/**
 * `./brainstem start`: prerequisites → configure on first run → start.
 *
 * `deps.doctor` must run only the machine-level checks (Node/Docker/daemon/
 * Compose — `runDoctorChecks({ prerequisitesOnly: true })`) so a missing
 * `.env` never blocks a first run. If it reports a failure, `runStart`
 * returns that code immediately without touching `.env` or starting
 * anything. Otherwise `setup` runs only when `.env` doesn't exist yet, then
 * `up` always runs.
 */
export async function runStart(deps: StartDeps): Promise<number> {
  deps.print('Checking prerequisites…');
  const doctorCode = await deps.doctor();
  if (doctorCode !== 0) return doctorCode;

  if (!(await deps.hasEnv())) {
    deps.print("First run — let's configure brainstem");
    await deps.setup();
  }

  deps.print('Starting…');
  return deps.up();
}
