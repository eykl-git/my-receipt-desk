/**
 * Clocks (design §8). The demo workspace uses a fixed clock: 2026-03-31T09:00Z
 * plus `meta.demoState.clockTick` seconds, where the tick is bumped once inside
 * each write, so IDs and timestamps replay identically. The personal workspace
 * uses the system clock.
 */
export const DEMO_EPOCH = '2026-03-31T09:00:00.000Z';

export function demoTime(tick: number): string {
  return new Date(Date.parse(DEMO_EPOCH) + tick * 1000).toISOString();
}
