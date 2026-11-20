import type { CompositionEvent, KeyboardEvent } from "react";

// Nested controls share state so a companion key is consumed only once.
const inputs = new WeakMap<EventTarget, { composing: boolean; endedAt?: number }>();
export function startComposition(event: CompositionEvent<HTMLElement>) {
  inputs.set(event.target, { composing: true });
}
export function endComposition(event: CompositionEvent<HTMLElement>) {
  inputs.set(event.target, { composing: false, endedAt: performance.now() });
}

/** Leave candidate handling to the IME; swallow one companion Enter, not the next intentional key. */
export function guardImeKey(event: KeyboardEvent<HTMLElement>): boolean {
  const state = inputs.get(event.target);
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || state?.composing) {
    event.stopPropagation();
    return true;
  }
  if (event.key === "Enter" && state?.endedAt !== undefined && performance.now() - state.endedAt < 500) {
    state.endedAt = undefined;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  if (state) state.endedAt = undefined;
  return false;
}
