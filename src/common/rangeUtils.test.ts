import { describe, expect, it } from 'bun:test';

import { randomGenerator } from '../../test.utils';
import { isValidRange, pinchedRange, type Range, scaledRange } from './rangeUtils';

// Some helpers.

const MAX_NB_OF_ZOOMS = 5000;

const zoomUntilDone = (range: Range, center: number, factor: number): 'invalid' | 'unchanged' => {
  // Scale the given range by the given factor around the given center until it becomes invalid or stops changing (e.g.,
  // once its ends are next to our center), checking that it remains valid (and keeps the given center) until then, and
  // return how it ended.

  let currentRange = range;

  for (let i = 0; i < MAX_NB_OF_ZOOMS; ++i) {
    const newRange = scaledRange(currentRange, center, factor);

    if (!isValidRange(newRange)) {
      return 'invalid';
    }

    if (newRange[0] === currentRange[0] && newRange[1] === currentRange[1]) {
      return 'unchanged';
    }

    expect(newRange[0]).toBeLessThanOrEqual(center);
    expect(newRange[1]).toBeGreaterThanOrEqual(center);

    currentRange = newRange;
  }

  throw new Error(`Still zooming after ${MAX_NB_OF_ZOOMS} zooms.`);
};

// isValidRange().

describe('isValidRange()', () => {
  it('accepts a range which minimum is smaller than its maximum', () => {
    expect(isValidRange([0, 1])).toBe(true);
    expect(isValidRange([-1e300, -1e299])).toBe(true);
    expect(isValidRange([1e-300, 2e-300])).toBe(true);
    expect(isValidRange([-0.5 * Number.MAX_VALUE, 0.5 * Number.MAX_VALUE])).toBe(true);
    expect(isValidRange([1, 1 + Number.EPSILON])).toBe(true);
    expect(isValidRange([0, Number.MIN_VALUE])).toBe(true);
  });

  it('rejects a range which ends are the same number or in the wrong order', () => {
    expect(isValidRange([1, 1])).toBe(false);
    expect(isValidRange([0, -0])).toBe(false);
    expect(isValidRange([1, 0])).toBe(false);
  });

  it('rejects a range which ends or length are not finite', () => {
    expect(isValidRange([Number.NaN, 1])).toBe(false);
    expect(isValidRange([0, Number.NaN])).toBe(false);
    expect(isValidRange([Number.NEGATIVE_INFINITY, 0])).toBe(false);
    expect(isValidRange([0, Number.POSITIVE_INFINITY])).toBe(false);
    expect(isValidRange([-Number.MAX_VALUE, Number.MAX_VALUE])).toBe(false);
  });
});

// scaledRange().

describe('scaledRange()', () => {
  it('scales a range around a center', () => {
    expect(scaledRange([0, 10], 5, 0.5)).toEqual([2.5, 7.5]);
    expect(scaledRange([0, 10], 0, 2)).toEqual([0, 20]);
    expect(scaledRange([0, 10], 8, 0.5)).toEqual([4, 9]);
    expect(scaledRange([-4, 4], 0, 1)).toEqual([-4, 4]);
  });

  it('ends up invalid or unchanged when zooming in, and invalid when zooming out, keeping its center', () => {
    // Note: zooming in eventually makes the two ends of our range the same number or the numbers next to our center
    //       (which zooming in further doesn't change), while zooming out eventually makes its length infinite.

    const random = randomGenerator(42);

    for (let i = 0; i < 100; ++i) {
      const min = (random() - 0.5) * 10 ** Math.floor(-20 + 40 * random());
      const max = min + 10 ** Math.floor(-10 + 20 * random()) * (1 + random());
      const center = min + (max - min) * random();

      expect(['invalid', 'unchanged']).toContain(zoomUntilDone([min, max], center, 0.5));
      expect(zoomUntilDone([min, max], center, 2)).toBe('invalid');
    }
  });
});

// pinchedRange().

describe('pinchedRange()', () => {
  it('scales a range so that a value moves from one fraction of it to another', () => {
    expect(pinchedRange([0, 10], 0.5, 0.5, 0.5)).toEqual([2.5, 7.5]);
    expect(pinchedRange([0, 10], 0.5, 0.25, 1)).toEqual([2.5, 12.5]);
    expect(pinchedRange([0, 10], 0, 0, 2)).toEqual([0, 20]);
  });

  it('keeps the pinched value under the fingers', () => {
    const random = randomGenerator(42);

    for (let i = 0; i < 1000; ++i) {
      const range: Range = [random() - 0.5, 1 + random()];
      const startFraction = random();
      const fraction = random();
      const factor = 0.1 + 10 * random();
      const value = range[0] + (range[1] - range[0]) * startFraction;
      const newRange = pinchedRange(range, startFraction, fraction, factor);

      expect(newRange[1] - newRange[0]).toBeCloseTo((range[1] - range[0]) * factor, 9);
      expect(newRange[0] + (newRange[1] - newRange[0]) * fraction).toBeCloseTo(value, 9);
    }
  });
});
