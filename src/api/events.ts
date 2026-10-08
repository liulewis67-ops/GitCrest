import type { GitCrestEventEnvelope } from "./bridge";

export function createEventSequenceTracker() {
  let previousEventSequence: number | undefined;

  return (event: GitCrestEventEnvelope): boolean => {
    const eventSequence = Number(event.eventId);
    const sequenceGap = Number.isSafeInteger(eventSequence)
      && previousEventSequence !== undefined
      && event.type !== "connection.resyncRequired"
      && eventSequence !== previousEventSequence + 1;
    if (Number.isSafeInteger(eventSequence)) previousEventSequence = eventSequence;
    return sequenceGap;
  };
}
