// Some utilities for touch interaction (see the pointer interaction section of PlotWidget.vue).

export const LONG_PRESS_DURATION = 500; // Like Android, the time (in milliseconds) after which a press is a long press.
export const DOUBLE_TAP_DELAY = 300; // Like Android, the maximum gap (in milliseconds) between two taps to double-tap.
export const TOUCH_TARGET_SIZE = 44; // Like Apple, the minimum size (in CSS pixels) of something to touch.

export const isDirectPointer = (pointerType: string): boolean => {
  // Return whether the given pointer type is that of a pointer that directly manipulates what it touches, i.e. a finger
  // or a pen, which (unlike a mouse) the browser uses to scroll the page, unless touch-action says otherwise.

  return pointerType === 'touch' || pointerType === 'pen';
};

export const axisEndSize = (axisLength: number, minSize: number): number => {
  // Return the size of one end of an axis of the given length, i.e. 10% of that length (like Plotly), but at least the
  // given minimum size (e.g., so that it can be touched), as long as the middle of that axis still takes at least half
  // of it.

  return Math.min(Math.max(0.1 * axisLength, minSize), 0.25 * axisLength);
};

export interface Tap {
  /** When the tap was pressed (in milliseconds). */
  pressTime: number;
  /** When the tap was released (in milliseconds). */
  releaseTime: number;
  /** Where the tap was pressed (in CSS pixels). */
  x: number;
  /** Where the tap was pressed (in CSS pixels). */
  y: number;
}

export const isDoubleTap = (firstTap: Tap | undefined, secondTap: Tap): boolean => {
  // Return whether the given taps make a double-tap, i.e. whether the second one was pressed at most DOUBLE_TAP_DELAY
  // milliseconds after the first one was released, and less than TOUCH_TARGET_SIZE pixels away from it.

  if (!firstTap) {
    return false;
  }

  const delay = secondTap.pressTime - firstTap.releaseTime;

  return (
    delay >= 0 &&
    delay <= DOUBLE_TAP_DELAY &&
    Math.hypot(secondTap.x - firstTap.x, secondTap.y - firstTap.y) < TOUCH_TARGET_SIZE
  );
};

export class LongPress {
  // A long press, i.e. a pointer that is held for LONG_PRESS_DURATION milliseconds without moving by the given tolerance
  // (or more) along either axis, in which case the given callback gets called.

  private timeoutId: ReturnType<typeof setTimeout> | undefined;
  private hasFired = false;

  constructor(
    private readonly startX: number,
    private readonly startY: number,
    private readonly tolerance: number,
    onLongPress: () => void
  ) {
    this.timeoutId = setTimeout(() => {
      this.timeoutId = undefined;
      this.hasFired = true;

      onLongPress();
    }, LONG_PRESS_DURATION);
  }

  get fired(): boolean {
    // Return whether our pointer has been held long enough.

    return this.hasFired;
  }

  get pending(): boolean {
    // Return whether our pointer may still become a long press.

    return this.timeoutId !== undefined;
  }

  move(x: number, y: number): void {
    // Our pointer has moved, so it can't become a long press anymore if it has moved too far from where it started.

    if (Math.max(Math.abs(x - this.startX), Math.abs(y - this.startY)) >= this.tolerance) {
      this.cancel();
    }
  }

  cancel(): void {
    // Our pointer can't become a long press anymore (e.g., it has been released).

    clearTimeout(this.timeoutId);

    this.timeoutId = undefined;
  }
}
