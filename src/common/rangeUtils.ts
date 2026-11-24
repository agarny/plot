// The range of an axis, i.e. its minimum and maximum values, and how it gets zoomed (see zoomTo() in PlotWidget.vue).

export type Range = [number, number];

export const isValidRange = (range: Range): boolean => {
  // Return whether the given range is valid, i.e. whether its minimum is smaller than its maximum and its length is a
  // finite number (e.g., not if we zoomed in so much that its two ends are the same number, or out so much that its
  // length is not a finite number anymore, in which case we couldn't map our values to pixels or zoom back in).

  return range[0] < range[1] && Number.isFinite(range[1] - range[0]);
};

export const scaledRange = (range: Range, center: number, factor: number): Range => {
  // Return the given range, scaled by the given factor around the given center.

  return [center + factor * (range[0] - center), center + factor * (range[1] - center)];
};

export const pinchedRange = (range: Range, startFraction: number, fraction: number, factor: number): Range => {
  // Return the given range, scaled by the given factor, so that the value that was at the given start fraction of the
  // given range is now at the given fraction of the new range.

  const value = range[0] + (range[1] - range[0]) * startFraction;
  const length = (range[1] - range[0]) * factor;
  const min = value - length * fraction;

  return [min, min + length];
};
