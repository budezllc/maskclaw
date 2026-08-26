import { useEffect, useRef, type RefObject } from "react";
import {
  TAPE_STICK_RESUME_MS,
  isAtBottom,
  onManualScroll,
  resumeAfterIdle,
  shouldStickToBottom,
  type TapeStickState,
} from "./tapeStick";

export function useTapeStick(ref: RefObject<HTMLElement | null>, content: string): void {
  const state = useRef<TapeStickState>({ follow: true, lastManualAt: 0 });
  const ignoreProgrammatic = useRef(false);
  const resumeTimer = useRef<number>(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const stick = () => {
      ignoreProgrammatic.current = true;
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        ignoreProgrammatic.current = false;
      });
    };

    const armIdleResume = () => {
      window.clearTimeout(resumeTimer.current);
      resumeTimer.current = window.setTimeout(() => {
        const now = Date.now();
        state.current = resumeAfterIdle(state.current, now);
        if (state.current.follow) stick();
      }, TAPE_STICK_RESUME_MS);
    };

    const onScroll = () => {
      if (ignoreProgrammatic.current) return;
      const now = Date.now();
      state.current = onManualScroll(now, isAtBottom(el));
      if (state.current.follow) {
        window.clearTimeout(resumeTimer.current);
      } else {
        armIdleResume();
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(resumeTimer.current);
    };
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = Date.now();
    if (!shouldStickToBottom(state.current, now)) return;
    state.current = { follow: true, lastManualAt: state.current.lastManualAt };
    ignoreProgrammatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      ignoreProgrammatic.current = false;
    });
  }, [content, ref]);
}
