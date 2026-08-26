import type { SetupForm } from "./setupTypes";

export const SETUP_DRAFT_KEY = "switchyard.setup-form";

const memory = new Map<string, string>();

function webStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    /* private mode / SSR */
  }
  return null;
}

export function writeSetupDraft(form: SetupForm): void {
  const raw = JSON.stringify(form);
  const store = webStorage();
  if (store) {
    store.setItem(SETUP_DRAFT_KEY, raw);
    return;
  }
  memory.set(SETUP_DRAFT_KEY, raw);
}

export function readSetupDraft(): SetupForm | null {
  const store = webStorage();
  const raw = store ? store.getItem(SETUP_DRAFT_KEY) : (memory.get(SETUP_DRAFT_KEY) ?? null);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SetupForm;
    if (!parsed?.cloud || !parsed?.locals) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSetupDraft(): void {
  webStorage()?.removeItem(SETUP_DRAFT_KEY);
  memory.delete(SETUP_DRAFT_KEY);
}
