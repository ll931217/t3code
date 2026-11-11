import { useSyncExternalStore } from "react";

export const REDUCE_EFFECTS_CLASS = "reduce-effects";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// The host's env var cannot change while the window lives, and the answer costs a sync IPC call.
const hostFlags = new WeakMap<object, boolean>();

function hostRequestsReduceEffects(): boolean {
  const bridge = window.desktopBridge;
  if (!bridge?.getReduceEffects) return false;
  let flag = hostFlags.get(bridge);
  if (flag === undefined) {
    flag = bridge.getReduceEffects() === true;
    hostFlags.set(bridge, flag);
  }
  return flag;
}

/**
 * True when the desktop host asked for it (T3CODE_REDUCE_EFFECTS) or the OS asks for reduced
 * motion. The OS setting is the only switch available to a browser connected to a remote `t3`.
 */
export function shouldReduceEffects(): boolean {
  if (typeof window === "undefined") return false;
  return (
    hostRequestsReduceEffects() || (window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false)
  );
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia?.(REDUCED_MOTION_QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}

/** Keeps the `reduce-effects` class on <html> in step with `shouldReduceEffects`. */
export function applyReduceEffects(): () => void {
  const sync = () =>
    document.documentElement.classList.toggle(REDUCE_EFFECTS_CLASS, shouldReduceEffects());
  sync();
  return subscribeToReducedMotion(sync);
}

export function useReduceEffects(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, shouldReduceEffects, () => false);
}
