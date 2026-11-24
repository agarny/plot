// The spacing and values of the ticks of an axis (see axisSplits() in PlotWidget.vue), i.e. multiples of a "nice"
// spacing (i.e. 1, 2, or 5 times a power of ten).

export const MAX_NB_OF_TICKS = 1000; // A safeguard against an axis needing an unreasonable number of ticks.

export const roundDTick = (roughDTick: number): number => {
  // Round the given rough tick spacing up to the next "nice" value, i.e. 2, 5, or 10 times a power of ten.
  // Note: our base and value may suffer from floating point errors (e.g., our tick spacing may be 5 * 1e24, i.e.
  //       4.999999999999999e24, which divided by 1e24 is 4.999999999999999), in which case a "nice" value would get
  //       rounded up to itself and axisSplits() would loop forever, hence our tolerance. We also make sure that we
  //       always return a bigger value, even if our tolerance is not enough (e.g., for a subnormal value).

  const base = 10 ** Math.floor(Math.log10(roughDTick));
  const value = (1 + 1e-9) * (roughDTick / base);
  const res = base * ([2, 5, 10, 20].find((niceValue: number) => niceValue > value) ?? 20);

  return res > roughDTick ? res : 2 * roughDTick;
};

export const ticksBetween = (min: number, max: number, dtick: number): number[] => {
  // Return the multiples of the given tick spacing that are between the given minimum and maximum values.
  // Note #1: we round our ticks to 14 significant digits, so that they don't suffer from floating point errors (e.g.,
  //          0.30000000000000004 rather than 0.3).
  // Note #2: we count our ticks rather than increment our tick index since the latter may not change if it is big
  //          enough (e.g., with a tiny range far away from zero), in which case we would end up in an endless loop.

  const res: number[] = [];
  const tolerance = 1e-9 * dtick;
  const first = Math.ceil((min - tolerance) / dtick);
  const nbOfTicks = Math.min(Math.floor((max + tolerance) / dtick) - first + 1, MAX_NB_OF_TICKS);

  for (let i = 0; i < nbOfTicks; ++i) {
    res.push(Number.parseFloat(((first + i) * dtick).toPrecision(14)));
  }

  return res;
};
