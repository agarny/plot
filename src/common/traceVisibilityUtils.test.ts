import { describe, expect, it } from 'bun:test';

import {
  isolatedTraceVisibilities,
  isSoleVisibleTrace,
  legendTraceAction,
  toggledTraceVisibilities
} from './traceVisibilityUtils';

// toggledTraceVisibilities().

describe('toggledTraceVisibilities()', () => {
  it('toggles the visibility of the given trace, without changing the given visibilities', () => {
    const visibilities = [true, false, true];

    expect(toggledTraceVisibilities(visibilities, 0)).toEqual([false, false, true]);
    expect(toggledTraceVisibilities(visibilities, 1)).toEqual([true, true, true]);
    expect(visibilities).toEqual([true, false, true]);
  });

  it('considers a trace with no visibility as visible', () => {
    expect(toggledTraceVisibilities([], 0)).toEqual([false]);
  });
});

// isSoleVisibleTrace().

describe('isSoleVisibleTrace()', () => {
  it('returns whether the given trace is the only visible one', () => {
    expect(isSoleVisibleTrace([false, true, false], 1)).toBe(true);
    expect(isSoleVisibleTrace([false, true, true], 1)).toBe(false);
    expect(isSoleVisibleTrace([false, false, false], 1)).toBe(false);
    expect(isSoleVisibleTrace([true], 0)).toBe(true);
    expect(isSoleVisibleTrace([false], 0)).toBe(false);
  });
});

// isolatedTraceVisibilities().

describe('isolatedTraceVisibilities()', () => {
  it('isolates the given trace or, if it is already the only visible one, shows all the traces again', () => {
    expect(isolatedTraceVisibilities([true, true, true], 1)).toEqual([false, true, false]);
    expect(isolatedTraceVisibilities([true, false, false], 1)).toEqual([false, true, false]);
    expect(isolatedTraceVisibilities([false, true, false], 1)).toEqual([true, true, true]);
  });
});

// legendTraceAction().

describe('legendTraceAction()', () => {
  describe('with one trace', () => {
    it('shows or hides the trace', () => {
      expect(legendTraceAction([true], 1, 0)).toEqual({ label: 'Hide Trace', visibilities: [false] });
      expect(legendTraceAction([false], 1, 0)).toEqual({ label: 'Show Trace', visibilities: [true] });
    });

    it('hides the trace when it has no visibility yet', () => {
      expect(legendTraceAction([], 1, 0)).toEqual({ label: 'Hide Trace', visibilities: [false] });
    });
  });

  describe('with several traces', () => {
    it('isolates the trace when all the traces are visible', () => {
      expect(legendTraceAction([true, true], 2, 0)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [true, false]
      });
      expect(legendTraceAction([true, true], 2, 1)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [false, true]
      });
      expect(legendTraceAction([true, true, true], 3, 0)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [true, false, false]
      });
      expect(legendTraceAction([true, true, true], 3, 1)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [false, true, false]
      });
      expect(legendTraceAction([true, true, true], 3, 2)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [false, false, true]
      });
    });

    it('shows all the traces again when the trace is the only visible one', () => {
      expect(legendTraceAction([true, false], 2, 0)).toEqual({
        label: 'Show All Traces',
        visibilities: [true, true]
      });
      expect(legendTraceAction([false, true], 2, 1)).toEqual({
        label: 'Show All Traces',
        visibilities: [true, true]
      });
      expect(legendTraceAction([false, true, false], 3, 1)).toEqual({
        label: 'Show All Traces',
        visibilities: [true, true, true]
      });
      expect(legendTraceAction([false, false, true], 3, 2)).toEqual({
        label: 'Show All Traces',
        visibilities: [true, true, true]
      });
    });

    it('isolates the trace when it is hidden, even if another trace is the only visible one', () => {
      expect(legendTraceAction([false, true], 2, 0)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [true, false]
      });
      expect(legendTraceAction([true, false, false], 3, 2)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [false, false, true]
      });
    });

    it('isolates the trace when all the traces are hidden', () => {
      expect(legendTraceAction([false, false], 2, 1)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [false, true]
      });
      expect(legendTraceAction([false, false, false], 3, 0)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [true, false, false]
      });
    });

    it('isolates the trace when some other traces are hidden, but not all of them', () => {
      expect(legendTraceAction([true, true, false], 3, 0)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [true, false, false]
      });
      expect(legendTraceAction([false, true, true, false], 4, 2)).toEqual({
        label: 'Show Only This Trace',
        visibilities: [false, false, true, false]
      });
    });

    it('isolates the trace or shows all the traces again, for any visibilities of 2 to 6 traces', () => {
      // Check all the possible visibilities of our traces, for each of our traces, making sure that the given
      // visibilities don't get changed.

      for (let nbOfTraces = 2; nbOfTraces <= 6; ++nbOfTraces) {
        for (let bits = 0; bits < 1 << nbOfTraces; ++bits) {
          const visibilities = Array.from(
            { length: nbOfTraces },
            (_value: unknown, i: number) => (bits & (1 << i)) !== 0
          );
          const visibilitiesCopy = visibilities.slice();

          for (let index = 0; index < nbOfTraces; ++index) {
            const isSoleVisible = visibilities.every((visible: boolean, i: number) => visible === (i === index));
            const action = legendTraceAction(visibilities, nbOfTraces, index);

            expect(action.label).toBe(isSoleVisible ? 'Show All Traces' : 'Show Only This Trace');
            expect(action.visibilities).toEqual(
              visibilities.map((_visible: boolean, i: number) => isSoleVisible || i === index)
            );
            expect(visibilities).toEqual(visibilitiesCopy);
          }
        }
      }
    });
  });

  it('depends on the number of traces, even when the trace is the only visible one', () => {
    // A visible trace that is the only trace can only be hidden, while a visible trace that is the only visible one
    // among several traces gets all the traces shown again.

    expect(legendTraceAction([true], 1, 0)).toEqual({ label: 'Hide Trace', visibilities: [false] });
    expect(legendTraceAction([true, false], 2, 0)).toEqual({
      label: 'Show All Traces',
      visibilities: [true, true]
    });
  });
});
