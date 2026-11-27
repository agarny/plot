import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  axisEndSize,
  DOUBLE_TAP_DELAY,
  isDirectPointer,
  isDoubleTap,
  LONG_PRESS_DURATION,
  LongPress,
  TOUCH_TARGET_SIZE
} from './touchUtils';

afterEach(() => {
  mock.restore();
});

// isDirectPointer().

describe('isDirectPointer()', () => {
  it('returns whether a pointer is a finger or a pen', () => {
    expect(isDirectPointer('touch')).toBe(true);
    expect(isDirectPointer('pen')).toBe(true);
    expect(isDirectPointer('mouse')).toBe(false);
    expect(isDirectPointer('')).toBe(false);
  });
});

// axisEndSize().

describe('axisEndSize()', () => {
  it('returns 10% of the length of an axis if it is at least the minimum size', () => {
    expect(axisEndSize(1000, TOUCH_TARGET_SIZE)).toBe(100);
    expect(axisEndSize(300, 0)).toBe(30);
  });

  it('returns the minimum size if 10% of the length of an axis is smaller', () => {
    expect(axisEndSize(300, TOUCH_TARGET_SIZE)).toBe(TOUCH_TARGET_SIZE);
  });

  it('returns at most 25% of the length of an axis', () => {
    expect(axisEndSize(100, TOUCH_TARGET_SIZE)).toBe(25);
    expect(axisEndSize(0, TOUCH_TARGET_SIZE)).toBe(0);
  });
});

// isDoubleTap().

describe('isDoubleTap()', () => {
  const firstTap = { pressTime: 1000, releaseTime: 1100, x: 50, y: 60 };
  const secondTap = (delay: number, x: number = 50, y: number = 60) => ({
    pressTime: 1100 + delay,
    releaseTime: 1100 + delay + 100,
    x,
    y
  });

  it('returns false if there is no first tap', () => {
    expect(isDoubleTap(undefined, secondTap(100))).toBe(false);
  });

  it('returns whether the second tap was pressed soon enough after the first one was released', () => {
    expect(isDoubleTap(firstTap, secondTap(0))).toBe(true);
    expect(isDoubleTap(firstTap, secondTap(DOUBLE_TAP_DELAY))).toBe(true);
    expect(isDoubleTap(firstTap, secondTap(DOUBLE_TAP_DELAY + 1))).toBe(false);
    expect(isDoubleTap(firstTap, secondTap(-1))).toBe(false);
  });

  it('returns whether the second tap was pressed close enough to the first one', () => {
    expect(isDoubleTap(firstTap, secondTap(100, 50 + TOUCH_TARGET_SIZE - 1, 60))).toBe(true);
    expect(isDoubleTap(firstTap, secondTap(100, 50, 60 - TOUCH_TARGET_SIZE))).toBe(false);
    expect(isDoubleTap(firstTap, secondTap(100, 50 + 0.8 * TOUCH_TARGET_SIZE, 60 + 0.8 * TOUCH_TARGET_SIZE))).toBe(
      false
    );
  });
});

// LongPress.

describe('LongPress', () => {
  let timeouts: [callback: () => void, delay: number | undefined][];
  let clearedTimeouts: unknown[];

  beforeEach(() => {
    // Mock setTimeout() and clearTimeout(), so that we can run our long press callback when we want.

    timeouts = [];
    clearedTimeouts = [];

    spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      timeouts.push([callback, delay]);

      return timeouts.length;
    }) as typeof setTimeout);
    spyOn(globalThis, 'clearTimeout').mockImplementation(((id: unknown) => {
      clearedTimeouts.push(id);
    }) as typeof clearTimeout);
  });

  it('fires once the pointer has been held long enough', () => {
    let nbOfCalls = 0;
    const longPress = new LongPress(10, 20, 8, () => {
      ++nbOfCalls;
    });

    expect(timeouts.length).toBe(1);
    expect(timeouts[0]?.[1]).toBe(LONG_PRESS_DURATION);
    expect(longPress.pending).toBe(true);
    expect(longPress.fired).toBe(false);

    longPress.move(17, 13);

    expect(longPress.pending).toBe(true);

    timeouts[0]?.[0]();

    expect(nbOfCalls).toBe(1);
    expect(longPress.pending).toBe(false);
    expect(longPress.fired).toBe(true);
  });

  it("doesn't fire if the pointer has moved too far, along either axis", () => {
    for (const [x, y] of [
      [18, 20],
      [2, 20],
      [10, 28],
      [10, 12]
    ] as const) {
      const longPress = new LongPress(10, 20, 8, () => {});

      longPress.move(x, y);

      expect(longPress.pending).toBe(false);
      expect(longPress.fired).toBe(false);
      expect(clearedTimeouts.at(-1)).toBe(timeouts.length);
    }
  });

  it("doesn't fire once it has been cancelled", () => {
    const longPress = new LongPress(10, 20, 8, () => {});

    longPress.cancel();

    expect(longPress.pending).toBe(false);
    expect(longPress.fired).toBe(false);
    expect(clearedTimeouts).toEqual([1]);
  });
});
