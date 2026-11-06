export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export type FailureState = { failed: number; lockedUntil: string | null };

export function isLocked(lockedUntil: string | null, now: Date): boolean {
  if (!lockedUntil) return false;
  const t = Date.parse(lockedUntil);
  return Number.isFinite(t) && t > now.getTime();
}

/** State after one more failed attempt. The 5th failure locks for 15 minutes. */
export function nextFailureState(state: FailureState, now: Date): FailureState {
  if (isLocked(state.lockedUntil, now)) return state;
  // A lock that has expired starts a fresh count.
  const failed = (state.lockedUntil ? 0 : state.failed) + 1;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    return { failed, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() };
  }
  return { failed, lockedUntil: null };
}
