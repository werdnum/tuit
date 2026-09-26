export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * A clock that can be pinned to a fixed instant. Only wired up when TUIT_TEST_CLOCK=1, so the
 * whole stack (web, CLI, MCP, feed) can be driven through missed recurrences and expiry.
 */
export class SettableClock implements Clock {
  private fixed: Date | null = null;

  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }

  set(at: Date | null): void {
    this.fixed = at;
  }
}
