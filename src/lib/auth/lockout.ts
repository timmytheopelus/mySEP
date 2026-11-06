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
  // A parsable, expired lock starts a fresh count; an unparsable value must not reset it.
  const expired = state.lockedUntil !== null && Number.isFinite(Date.parse(state.lockedUntil));
  const failed = (expired ? 0 : state.failed) + 1;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    return { failed, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() };
  }
  return { failed, lockedUntil: null };
}
