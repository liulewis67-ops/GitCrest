type Listener = (host: string) => void;

const listeners = new Set<Listener>();

/** Runs after a credential for `host` was saved, so work that failed for lack of it can be offered again. */
export function onCredentialSaved(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitCredentialSaved(host: string): void {
  for (const listener of [...listeners]) listener(host);
}
