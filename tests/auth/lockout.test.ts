import { describe, expect, it } from "vitest";
import { isLocked, nextFailureState } from "@/lib/auth/lockout";

const now = new Date("2026-11-06T10:00:00.000Z");
const clean = { failed: 0, lockedUntil: null };

describe("lockout", () => {
  it("counts failures 1..4 without locking", () => {
    let s: { failed: number; lockedUntil: string | null } = clean;
    for (let i = 1; i <= 4; i++) {
      s = nextFailureState(s, now);
      expect(s).toEqual({ failed: i, lockedUntil: null });
    }
  });
  it("locks on the 5th failure for 15 minutes", () => {
    const s = nextFailureState({ failed: 4, lockedUntil: null }, now);
    expect(s.failed).toBe(5);
    expect(s.lockedUntil).toBe("2026-11-06T10:15:00.000Z");
  });
  it("restarts the count after an expired lock", () => {
    const s = nextFailureState({ failed: 5, lockedUntil: "2026-11-06T09:00:00.000Z" }, now);
    expect(s).toEqual({ failed: 1, lockedUntil: null });
  });
  it("keeps counting when lockedUntil is unparsable (no reset)", () => {
    expect(nextFailureState({ failed: 3, lockedUntil: "garbage" }, now)).toEqual({ failed: 4, lockedUntil: null });
    expect(nextFailureState({ failed: 4, lockedUntil: "garbage" }, now).lockedUntil).toBe("2026-11-06T10:15:00.000Z");
  });
  it("does not extend an active lock", () => {
    const locked = { failed: 5, lockedUntil: "2026-11-06T10:10:00.000Z" };
    expect(nextFailureState(locked, now)).toEqual(locked);
  });
  it("isLocked is true before and false at/after expiry; null/invalid unlocked", () => {
    const until = "2026-11-06T10:15:00.000Z";
    expect(isLocked(until, new Date("2026-11-06T10:14:59.999Z"))).toBe(true);
    expect(isLocked(until, new Date(until))).toBe(false);
    expect(isLocked(until, new Date("2026-11-06T10:16:00.000Z"))).toBe(false);
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked("garbage", now)).toBe(false);
  });
});
