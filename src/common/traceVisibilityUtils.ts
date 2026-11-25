// The visibility of our traces, as changed through our legend (see setTraceVisibilities() in PlotWidget.vue).
// Note: a trace with no visibility (e.g., a trace that was just added) is visible.

export const toggledTraceVisibilities = (visibilities: boolean[], index: number): boolean[] => {
  // Return the given visibilities, with the visibility of the given trace toggled.

  const res = visibilities.slice();

  res[index] = !(res[index] ?? true);

  return res;
};

export const isSoleVisibleTrace = (visibilities: boolean[], index: number): boolean => {
  // Return whether the given trace is the only visible one, given the visibilities of our traces.

  return visibilities.every((visible: boolean, i: number) => visible === (i === index));
};

export const isolatedTraceVisibilities = (visibilities: boolean[], index: number): boolean[] => {
  // Return the given visibilities, with the given trace isolated (i.e. with all the other traces hidden) or, if it is
  // already the only visible trace, with all our traces shown again.

  const isSoleVisible = isSoleVisibleTrace(visibilities, index);

  return visibilities.map((_visible: boolean, i: number) => isSoleVisible || i === index);
};

export interface LegendTraceAction {
  /** The label of the action. */
  label: string;
  /** The visibilities of our traces once the action has been chosen. */
  visibilities: boolean[];
}

export const legendTraceAction = (visibilities: boolean[], nbOfTraces: number, index: number): LegendTraceAction => {
  // Return the action that the context menu of the given legend item starts with, i.e. to isolate its trace (or to show
  // all our traces again) or, if there is only one trace (in which case isolating it makes no sense), to show or hide
  // it.

  if (nbOfTraces === 1) {
    const visible = visibilities[index] ?? true;

    return {
      label: visible ? 'Hide Trace' : 'Show Trace',
      visibilities: toggledTraceVisibilities(visibilities, index)
    };
  }

  return {
    label: isSoleVisibleTrace(visibilities, index) ? 'Show All Traces' : 'Show Only This Trace',
    visibilities: isolatedTraceVisibilities(visibilities, index)
  };
};
