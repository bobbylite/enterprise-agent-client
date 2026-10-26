export const BOTTOM_THRESHOLD_PX = 48;

export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export interface StickState {
  pinned: boolean;
  showJump: boolean;
  /** Scroll the transcript to the latest content. */
  scroll: boolean;
  scrollTop: number;
}

/**
 * Stay pinned while content streams. A deliberate scroll upward pauses that
 * and asks for a jump. Returning to the bottom pins again. Content growth
 * that does not move scrollTop does not count as a user scroll.
 */
export function nextStickState(
  current: { pinned: boolean; scrollTop: number },
  event: { type: 'scroll'; scrollTop: number; scrollHeight: number; clientHeight: number } | { type: 'content' },
): StickState {
  if (event.type === 'content') {
    if (current.pinned) return { pinned: true, showJump: false, scroll: true, scrollTop: current.scrollTop };
    return { pinned: false, showJump: true, scroll: false, scrollTop: current.scrollTop };
  }
  const near = isNearBottom(event.scrollTop, event.scrollHeight, event.clientHeight);
  if (near) return { pinned: true, showJump: false, scroll: false, scrollTop: event.scrollTop };
  const movedUp = event.scrollTop < current.scrollTop - 1;
  if (movedUp) return { pinned: false, showJump: true, scroll: false, scrollTop: event.scrollTop };
  return { pinned: current.pinned, showJump: !current.pinned, scroll: false, scrollTop: event.scrollTop };
}
