import { describe, expect, it } from 'vitest';
import { isNearBottom, nextStickState } from '../src/shared/chat/stick';

describe('stick to bottom', () => {
  it('scrolls when pinned content arrives and pauses after a deliberate scroll up', () => {
    expect(isNearBottom(900, 1000, 80)).toBe(true);
    expect(isNearBottom(100, 1000, 80)).toBe(false);

    const pinned = nextStickState({ pinned: true, scrollTop: 900 }, { type: 'content' });
    expect(pinned).toMatchObject({ pinned: true, showJump: false, scroll: true });

    const away = nextStickState(
      { pinned: true, scrollTop: 900 },
      { type: 'scroll', scrollTop: 120, scrollHeight: 1000, clientHeight: 80 },
    );
    expect(away).toMatchObject({ pinned: false, showJump: true, scroll: false });

    const grown = nextStickState(
      { pinned: true, scrollTop: 900 },
      { type: 'scroll', scrollTop: 900, scrollHeight: 1400, clientHeight: 80 },
    );
    expect(grown).toMatchObject({ pinned: true, showJump: false, scroll: false });

    const streaming = nextStickState({ pinned: false, scrollTop: 120 }, { type: 'content' });
    expect(streaming).toMatchObject({ pinned: false, showJump: true, scroll: false });

    const back = nextStickState(
      { pinned: false, scrollTop: 120 },
      { type: 'scroll', scrollTop: 1320, scrollHeight: 1400, clientHeight: 80 },
    );
    expect(back).toMatchObject({ pinned: true, showJump: false, scroll: false });
    expect(nextStickState({ pinned: true, scrollTop: back.scrollTop }, { type: 'content' }).scroll).toBe(true);
  });
});
