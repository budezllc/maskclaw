export const TAPE_STICK_RESUME_MS = 30_000;
export const TAPE_BOTTOM_SLOP_PX = 16;

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface TapeStickState {
  follow: boolean;
  lastManualAt: number;
}

export function isAtBottom(box: ScrollBox, slopPx = TAPE_BOTTOM_SLOP_PX): boolean {
  return box.scrollHeight - box.clientHeight - box.scrollTop <= slopPx;
}

export function onManualScroll(now: number, atBottom: boolean): TapeStickState {
  return { follow: atBottom, lastManualAt: now };
}

export function shouldStickToBottom(state: TapeStickState, now: number, resumeMs = TAPE_STICK_RESUME_MS): boolean {
  return state.follow || now - state.lastManualAt >= resumeMs;
}

export function resumeAfterIdle(state: TapeStickState, now: number, resumeMs = TAPE_STICK_RESUME_MS): TapeStickState {
  if (state.follow || now - state.lastManualAt < resumeMs) return state;
  return { follow: true, lastManualAt: state.lastManualAt };
}
