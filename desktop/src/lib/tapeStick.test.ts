import { describe, expect, it } from "vitest";
import {
  TAPE_STICK_RESUME_MS,
  isAtBottom,
  onManualScroll,
  resumeAfterIdle,
  shouldStickToBottom,
} from "./tapeStick";

describe("tape stick", () => {
  it("treats the viewport as at bottom within slop", () => {
    expect(isAtBottom({ scrollTop: 84, scrollHeight: 200, clientHeight: 100 }, 16)).toBe(true);
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 100 }, 16)).toBe(false);
  });

  it("stops following after a manual scroll that leaves the bottom", () => {
    expect(onManualScroll(1000, false)).toEqual({ follow: false, lastManualAt: 1000 });
  });

  it("follows again when the user scrolls to the bottom", () => {
    expect(onManualScroll(2000, true)).toEqual({ follow: true, lastManualAt: 2000 });
  });

  it("keeps pinning output while following", () => {
    expect(shouldStickToBottom({ follow: true, lastManualAt: 0 }, 500)).toBe(true);
  });

  it("does not pin output until 30s with no scroll", () => {
    const paused = { follow: false, lastManualAt: 10_000 };
    expect(shouldStickToBottom(paused, 10_000 + TAPE_STICK_RESUME_MS - 1)).toBe(false);
    expect(shouldStickToBottom(paused, 10_000 + TAPE_STICK_RESUME_MS)).toBe(true);
  });

  it("re-enables follow after 30s idle even if still scrolled up", () => {
    const paused = { follow: false, lastManualAt: 1_000 };
    expect(resumeAfterIdle(paused, 1_000 + TAPE_STICK_RESUME_MS - 1).follow).toBe(false);
    expect(resumeAfterIdle(paused, 1_000 + TAPE_STICK_RESUME_MS).follow).toBe(true);
  });
});
