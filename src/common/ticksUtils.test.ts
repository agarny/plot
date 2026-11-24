import { describe, expect, it } from 'bun:test';

import { randomGenerator } from '../../test.utils';

import { MAX_NB_OF_TICKS, roundDTick, ticksBetween } from './ticksUtils';

// Some helpers.

const isNice = (dtick: number): boolean => {
  // Return whether the given tick spacing is "nice", i.e. 1, 2, or 5 times a power of ten (give or take floating point
  // errors).

  const base = 10 ** Math.floor(Math.log10(dtick) + 1e-9);

  return [1, 2, 5, 10].some((niceValue: number) => Math.abs(dtick / base - niceValue) < 1e-9);
};

// roundDTick().

describe('roundDTick()', () => {
  it('rounds up to the next nice value', () => {
    expect(roundDTick(1)).toBe(2);
    expect(roundDTick(1.5)).toBe(2);
    expect(roundDTick(2)).toBe(5);
    expect(roundDTick(3)).toBe(5);
    expect(roundDTick(5)).toBe(10);
    expect(roundDTick(7)).toBe(10);
    expect(roundDTick(10)).toBe(20);
    expect(roundDTick(1234)).toBe(2000);
    expect(roundDTick(0.003)).toBe(0.005);
    expect(roundDTick(0.05)).toBe(0.1);
  });

  it('goes beyond a nice value that suffers from floating point errors', () => {
    // Note: 5 * 1e24 is 4.999999999999999e24, which divided by 1e24 is 4.999999999999999, i.e. it would otherwise be
    //       rounded up to 5 * 1e24 again.

    const dtick = 5 * 1e24;

    expect(dtick / 1e24).toBeLessThan(5);
    expect(roundDTick(dtick) / 1e25).toBeCloseTo(1, 12);
  });

  it('always returns a bigger value, even for a subnormal value', () => {
    expect(roundDTick(Number.MIN_VALUE)).toBeGreaterThan(Number.MIN_VALUE);
    expect(roundDTick(3 * Number.MIN_VALUE)).toBeGreaterThan(3 * Number.MIN_VALUE);
  });

  it('returns a bigger nice value for values of any magnitude', () => {
    const random = randomGenerator(42);

    for (let i = 0; i < 10000; ++i) {
      const roughDTick = (1 + 9 * random()) * 10 ** Math.floor(-300 + 600 * random());
      const dtick = roundDTick(roughDTick);

      expect(dtick).toBeGreaterThan(roughDTick);
      expect(dtick).toBeLessThanOrEqual(2.5000001 * roughDTick);
      expect(isNice(dtick)).toBe(true);
    }
  });

  it('keeps going up when applied repeatedly, until it is no longer finite', () => {
    // Note: axisSplits() in PlotWidget.vue rounds its tick spacing up for as long as its tick labels would overlap, so
    //       our tick spacing must keep getting bigger, until it is no longer finite (which ends its loop).

    let dtick = Number.MIN_VALUE;
    let nbOfSteps = 0;

    while (Number.isFinite(dtick)) {
      const nextDTick = roundDTick(dtick);

      expect(nextDTick).toBeGreaterThan(dtick);

      dtick = nextDTick;
      ++nbOfSteps;
    }

    expect(dtick).toBe(Number.POSITIVE_INFINITY);
    expect(nbOfSteps).toBeLessThan(2000);
  });
});

// ticksBetween().

describe('ticksBetween()', () => {
  it('returns the multiples of the tick spacing within a range', () => {
    expect(ticksBetween(0, 1, 0.2)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(ticksBetween(-1, 1, 0.5)).toEqual([-1, -0.5, 0, 0.5, 1]);
    expect(ticksBetween(0.05, 0.95, 0.2)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(ticksBetween(-35, -5, 10)).toEqual([-30, -20, -10]);
    expect(ticksBetween(1e6, 5e6, 2e6)).toEqual([2e6, 4e6]);
  });

  it('rounds its ticks to 14 significant digits', () => {
    // Note: 3 * 0.1 is 0.30000000000000004.

    expect(ticksBetween(0.25, 0.35, 0.1)).toEqual([0.3]);
    expect(ticksBetween(0, 0.7, 0.1)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  });

  it('includes ends that are a tick, give or take floating point errors', () => {
    // Note: 0.7 / 0.1 is 6.999999999999999 and 0.3 / 0.1 is 2.9999999999999996.

    expect(ticksBetween(0.3, 0.7, 0.1)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(ticksBetween(0.1 + 0.2, 0.3, 0.1)).toEqual([0.3]);
  });

  it('returns no ticks if there is no multiple of the tick spacing within a range', () => {
    expect(ticksBetween(0.1, 0.15, 1)).toEqual([]);
    expect(ticksBetween(1, 0, 0.1)).toEqual([]);
  });

  it('returns no ticks for a tick spacing that is no longer finite', () => {
    expect(ticksBetween(-Number.MAX_VALUE, Number.MAX_VALUE, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('returns at most MAX_NB_OF_TICKS ticks', () => {
    expect(ticksBetween(0, 10 * MAX_NB_OF_TICKS, 1)).toHaveLength(MAX_NB_OF_TICKS);
  });

  it('ends for a tiny range far away from zero', () => {
    // Note: our tick index is then so big (i.e. beyond 2^53) that incrementing it doesn't change it.

    const ticks = ticksBetween(1e17, 1e17 + 1000, 1);

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(MAX_NB_OF_TICKS);

    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(1e17);
      expect(tick).toBeLessThanOrEqual(1e17 + 1000);
    }
  });
});
