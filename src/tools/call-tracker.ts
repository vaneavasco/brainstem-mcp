/** How long nothing may start before a stopping server stops taking calls. */
export const DRAIN_QUIET_MS = 250;
/** The longest a stopping server keeps taking calls, however busy the client is. */
export const DRAIN_ADMIT_MAX_MS = 1_000;

/**
 * Counts the tool calls that are running, so a server that is stopping can let them finish: a
 * write that has started is never cut in the middle, and its answer is still sent. Once
 * `drain()` has been asked for, a call that has not started yet is refused instead of started,
 * so stopping has an end.
 */
export class CallTracker {
  private running = 0;
  private started = 0;
  private draining = false;
  private announced = false;
  private waiters: (() => void)[] = [];
  private announce: () => void = () => {};
  /** Resolves when the server starts stopping: what a call parked on a long wait listens to. */
  readonly closing: Promise<void> = new Promise((resolve) => {
    this.announce = resolve;
  });

  /** True from the moment a drain is asked for, while late calls are still being let in. */
  get stopping(): boolean {
    return this.announced;
  }

  /** True once the quiet period is over: a call must not be started any more. */
  get closed(): boolean {
    return this.draining;
  }

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    this.running += 1;
    this.started += 1;
    try {
      return await fn();
    } finally {
      this.running -= 1;
      if (this.running === 0) for (const wake of this.waiters.splice(0)) wake();
    }
  }

  /**
   * Stops the intake, then resolves when nothing is running.
   *
   * The intake is not stopped at once, because a disconnect can arrive before the messages read
   * just ahead of it have been dispatched (the protocol layer builds its server instance
   * asynchronously): measured, a client that sent its calls and closed the pipe had none of them
   * run. So calls are still let in until nothing has started for `quietMs` — but never for longer
   * than `admitMaxMs` after the drain began: measured too, a client calling every few
   * milliseconds kept the quiet period from ever ending, and the stop then ran into its hard
   * time limit with writes cut in the middle.
   */
  async drain(quietMs = DRAIN_QUIET_MS, admitMaxMs = DRAIN_ADMIT_MAX_MS): Promise<void> {
    this.announced = true;
    this.announce(); // calls parked on the index stop waiting for long (see waitForIndex)
    const deadline = performance.now() + admitMaxMs;
    while (performance.now() < deadline) {
      const seen = this.started;
      const wait = Math.min(quietMs, Math.max(0, deadline - performance.now()));
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      if (this.running === 0 && this.started === seen) break;
    }
    this.draining = true;
    while (this.running > 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    // A call's answer is written by the protocol layer after the call returns: leave it the turn
    // it needs before the caller closes the transport.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
