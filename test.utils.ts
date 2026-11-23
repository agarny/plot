// Some utilities that are shared by our tests (see src/**/*.test.ts).

export const randomGenerator = (seed: number): (() => number) => {
  // Return a deterministic pseudo-random number generator (Mulberry32), so that our tests are reproducible.

  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const isFinitePoint = (xValues: Float64Array, yValues: Float64Array, index: number): boolean => {
  // Return whether the given point is finite, i.e. whether both its X and Y values are finite.

  return Number.isFinite(xValues[index]) && Number.isFinite(yValues[index]);
};
