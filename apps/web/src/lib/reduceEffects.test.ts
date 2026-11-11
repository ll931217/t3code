import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { REDUCE_EFFECTS_CLASS, applyReduceEffects, shouldReduceEffects } from "./reduceEffects";

function stubWindow(options: { desktopBridge?: unknown; prefersReducedMotion?: boolean }) {
  const listeners = new Set<() => void>();
  const media = {
    matches: options.prefersReducedMotion ?? false,
    addEventListener: (_type: "change", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) => void listeners.delete(listener),
  };
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (name: string, force?: boolean) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name: string) => classes.has(name),
    },
  };
  vi.stubGlobal("window", {
    desktopBridge: options.desktopBridge,
    matchMedia: vi.fn(() => media),
  });
  vi.stubGlobal("document", { documentElement: root });
  return {
    root,
    listeners,
    setPrefersReducedMotion: (matches: boolean) => {
      media.matches = matches;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("reduceEffects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "bridge true",
      desktopBridge: { getReduceEffects: () => true },
      media: false,
      on: true,
    },
    {
      name: "bridge false",
      desktopBridge: { getReduceEffects: () => false },
      media: false,
      on: false,
    },
    { name: "bridge absent", desktopBridge: undefined, media: false, on: false },
    { name: "bridge lacking the method", desktopBridge: {}, media: false, on: false },
    { name: "media matches", desktopBridge: undefined, media: true, on: true },
    { name: "neither", desktopBridge: { getReduceEffects: () => false }, media: false, on: false },
  ])("$name -> $on", ({ desktopBridge, media, on }) => {
    const { root } = stubWindow({ desktopBridge, prefersReducedMotion: media });
    expect(REDUCE_EFFECTS_CLASS).toBe("reduce-effects");
    expect(shouldReduceEffects()).toBe(on);

    const unsubscribe = applyReduceEffects();
    expect(root.classList.contains(REDUCE_EFFECTS_CLASS)).toBe(on);
    unsubscribe();
  });

  it("re-applies when the media query changes and stops after unsubscribe", () => {
    const { root, listeners, setPrefersReducedMotion } = stubWindow({});
    const unsubscribe = applyReduceEffects();
    expect(root.classList.contains(REDUCE_EFFECTS_CLASS)).toBe(false);

    setPrefersReducedMotion(true);
    expect(root.classList.contains(REDUCE_EFFECTS_CLASS)).toBe(true);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
