// The path level of detail of a trace, i.e. the points of a trace that we need to draw so that it looks the same (give
// or take a fraction of a pixel) as if all of its points were drawn, whether or not its X values are sorted (e.g., a
// phase plot). This complements our (column) level of detail (see levelOfDetailUtils.ts), which is (nearly) exact, but
// which requires sorted X values.
// Note #1: we simplify our path at different levels: level k has a tolerance of XSize / 4^k along the X axis and of
//          YSize / 4^k along the Y axis, where XSize (and YSize) is the smallest power of two that is at least as big
//          as the range of our X (and Y) values. (Our tolerances get four, rather than two, times smaller from one
//          level to the next, so that we have half as many levels to build, at the cost of using a level that has up to
//          four, rather than two, times smaller tolerances than needed, i.e. up to about two, rather than 1.4, times as
//          many points as needed for a smooth trace.) For each level, consecutive points are replaced with a segment,
//          from the first to the last of them, as long as all of them are within our tolerance of that segment, i.e.
//          within a distance of one once their X and Y values are divided by our X and Y tolerances. So, if the
//          tolerances of a level are no bigger than a fraction of a pixel, then what gets drawn using that level is
//          within that fraction of a pixel (times the square root of two, if both tolerances are that fraction of a
//          pixel) of what would otherwise get drawn, while the number of points to go through (and to draw) is about
//          the number of segments that are needed to draw our trace within that fraction of a pixel, which is much
//          smaller than its number of points for a smooth trace (e.g., about 1,000 rather than 1,000,000 for a
//          Lissajous curve).
// Note #2: our segments are found in one pass, from an anchor point (i.e. the first point of our trace, the first point
//          after a gap, or the last point of our previous segment): a point can be the end of our current segment if
//          its direction (from our anchor) is within the directions that keep our previous points within our tolerance
//          (i.e. our cone, see Note #3) and if it is at least as far from our anchor as our previous points that are
//          further than our tolerance from our anchor (so that none of them is beyond it), or if it is within our
//          tolerance of our anchor and so are our previous points (since a point within our tolerance of our anchor is
//          within our tolerance of any segment from our anchor). Otherwise, our previous point becomes the end of our
//          current segment and the anchor of our next segment. This means that a point (other than an anchor after a
//          gap) only becomes one of our points because of the point that follows it (see Note #5).
// Note #3: our cone is the intersection of the directions that keep each of our points (that is further than our
//          tolerance from our anchor) within our tolerance of our segment, i.e. the directions within asin(1 / d) of
//          the direction of a point at a distance d. Since each of those is less than half a turn wide, so is our cone,
//          which we keep as its two boundary directions, so that we can check whether a direction is within it using
//          cross products (i.e. without any trigonometry).
// Note #4: a gap (i.e. a point with a non-finite X or Y value) ends our current segment, and consecutive gaps are
//          replaced with the first of them, so that a gap in the data is drawn as a gap in the trace.
// Note #5: our levels are only updated when they are needed (see updatedLevel()), i.e. normally the one level that is
//          needed to draw our trace, so that we don't spend time updating levels that are not needed (e.g., while a
//          simulation is running, when our trace gets updated and drawn many times a second). Also, like our (column)
//          level of detail, a level is kept up to date incrementally, i.e. if only the last point onwards of a trace
//          may have changed (e.g., while a simulation is running), then we remove the points of the level from the
//          point before it (since it might have become one of its points because of it, see Note #2), and we resume
//          from the last point that we keep (as an anchor). However, our segments can be long (e.g., for our coarsest
//          levels), so resuming from our anchor would mean going through many points again. So, a level also keeps a
//          snapshot of its state just before our last point (since it is normally the first point that may have
//          changed), from which it resumes if it can. This means that updating a level with N new points costs O(N)
//          rather than O(size of the trace), while the first update of a level (e.g., once zoomed in) costs O(size of
//          the trace), which can be done bit by bit (see Note #9).
// Note #6: our values are relative to an origin (i.e. the first finite point of our trace), so that they keep as much
//          precision as possible (e.g., if they have a large offset). If the range of our values gets bigger than our
//          sizes (e.g., while a simulation is running), then we rebuild our levels for all of our points, which only
//          happens a few times since our sizes are powers of two (e.g., when the range of our values doubles). If the
//          range of our values is so big that one of our sizes would not be finite (i.e. bigger than 2^1023), then we
//          don't have any levels.
// Note #7: a level that hardly reduces the number of points of a trace (e.g., a fine level for a trace with fewer
//          points than segments to draw, or for noisy data) would only use memory, so once a trace has at least
//          MIN_NB_OF_POINTS_TO_DROP_LEVELS points, we drop a level that has more than MAX_LEVEL_RATIO times its number
//          of points when we update it (as soon as it has that many points, so that we don't spend time updating a
//          level that we are going to drop), as well as our finer levels (since our levels have more and more points as
//          they get finer). Since a level typically has at least twice as many points as the previous one, this means
//          that our levels typically have, at most, about as many points as our trace. A dropped level only comes back
//          if our levels get rebuilt (see Note #6) or if we start again from scratch (see Note #8).
// Note #8: like our (column) level of detail (see Note #8 of levelOfDetailUtils.ts), we keep track of the X and Y
//          values that we were last updated with, so that when we get updated with some values that are not a
//          continuation of them (see traceValues.ts), we start again from scratch, and otherwise only from our last
//          point (which may have changed), unless they are the very same values (i.e. the same arrays), which we assume
//          haven't changed (e.g., when a plot gets redrawn without its data having changed).
// Note #9: taking the points of a trace into account (see update()) and updating a level (see updatedLevel()) both cost
//          O(number of points), e.g. about 0.1 s for a trace of 10,000,000 points, which is too long to be done while
//          drawing a plot. So, they can also be done bit by bit (see buildLevel()), e.g. in the background. Our ranges
//          then cover the points that we have taken into account so far, but we only get our sizes (and therefore our
//          levels) once we have taken all of our points into account, and a level that has processed some of our points
//          resumes from its snapshot, like when our trace gets new points (see Note #5).

import { isContinuationOf } from './traceValues';

const NB_OF_LEVELS = 11; // Number of levels, i.e. from tolerances of XSize and YSize to tolerances 4^10 times smaller.
const MIN_SIZE_RATIO = 2 ** -40; // Minimum size relative to our values (e.g., if they are all the same).
const MIN_SIZE = 2 ** -1000; // Minimum size (e.g., if all of our values are zero).

export const MIN_NB_OF_POINTS_TO_DROP_LEVELS = 16384;
export const MAX_LEVEL_RATIO = 0.5;

// The state of a level while it processes our points (see processLevel()), which it keeps as a snapshot (see Note #5
// above).

const STATE_NONE = 0; // We have nothing in progress, i.e. we are at the start of our trace or after a gap.
const STATE_GAP = 1; // We are in a gap.
const STATE_SEGMENT = 2; // We have a segment in progress, from an anchor.

export interface PathLevelState {
  state: number;
  anchor: number; // Index of our anchor.
  anchorU: number; // Position of our anchor, relative to our origin and divided by our tolerances.
  anchorV: number;
  last: number; // Index of the end of our segment (i.e. of the last point that we processed), or of our anchor.
  maxSquaredDistance: number; // Max squared distance from our anchor (in tolerances) of our points beyond tolerance.
  fullCone: boolean; // Whether our cone allows all directions (i.e. no point constrains it yet).
  rightX: number; // Right (i.e. clockwise) boundary of our cone.
  rightY: number;
  leftX: number; // Left (i.e. counterclockwise) boundary of our cone.
  leftY: number;
}

const newState = (): PathLevelState => {
  return {
    state: STATE_NONE,
    anchor: -1,
    anchorU: 0,
    anchorV: 0,
    last: -1,
    maxSquaredDistance: 0,
    fullCone: true,
    rightX: 0,
    rightY: 0,
    leftX: 0,
    leftY: 0
  };
};

export interface PathLevel {
  indices: Int32Array; // Index of our points, i.e. the ends of our segments and the first of our gaps.
  count: number; // Number of our points.
  level: number; // Our level, i.e. our tolerances are XSize / 4^level and YSize / 4^level.
  openEnd: boolean; // Whether our last point is the end of a segment that may still be extended (see reopenLevel()).
  processedCount: number; // Number of points of our trace that we have processed.
  snapshotIndex: number; // Index of the point just before which we took our snapshot, or -1 if we don't have any.
  snapshotState: PathLevelState; // Our state just before that point (see Note #5 above).
  snapshotCount: number; // Our number of points just before that point.
}

export interface PathLevelOfDetail {
  count: number; // Number of points that we have taken into account (see update()).
  xOrigin: number; // Origin of our values (see Note #6 above).
  yOrigin: number;
  xSize: number; // Our sizes (see Note #1 above), or 0 if we don't have any (i.e. no finite point).
  ySize: number;
  xMin: number; // Range of the values of the points that we have taken into account.
  xMax: number;
  yMin: number;
  yMax: number;
  levels: PathLevel[]; // Our levels, from the coarsest one (i.e. level 0) to the finest one that we have kept.
  xValues: Float64Array | undefined; // X values that we were last updated with (see Note #8 above).
  yValues: Float64Array | undefined; // Y values that we were last updated with.
}

export const create = (): PathLevelOfDetail => {
  return {
    count: 0,
    xOrigin: 0,
    yOrigin: 0,
    xSize: 0,
    ySize: 0,
    xMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
    yMin: Number.POSITIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
    levels: [],
    xValues: undefined,
    yValues: undefined
  };
};

export const memoryUsage = (lod: PathLevelOfDetail): number => {
  // Return the number of bytes used by the given level of detail, i.e. by its levels.

  let res = 0;

  for (const level of lod.levels) {
    res += level.indices.byteLength;
  }

  return res;
};

const reset = (lod: PathLevelOfDetail): void => {
  // Reset the given level of detail, keeping track of the values that it was last updated with (since it gets reset
  // while being updated, see update()).

  const { xValues, yValues } = lod;

  Object.assign(lod, create());

  lod.xValues = xValues;
  lod.yValues = yValues;
};

export const invalidate = (lod: PathLevelOfDetail, from: number): void => {
  // Invalidate the given level of detail from the given point onwards (i.e. those points may have changed), resetting
  // it if all of its points may have changed (so that we get new sizes and that our levels don't keep any of our
  // previous points, e.g. if we now have no points), or if it doesn't have sizes yet (so that our ranges and origin,
  // which we get our sizes from, don't come from points that may have changed, see Note #9 above).

  if (from <= 0 || lod.xSize === 0) {
    reset(lod);
  } else {
    lod.count = Math.min(lod.count, from);

    for (const level of lod.levels) {
      level.processedCount = Math.min(level.processedCount, from);
    }
  }
};

const size = (min: number, max: number): number => {
  // Return the smallest power of two that is at least as big as the given range (see Note #1 above).

  const range = Math.max(max - min, Math.abs(min) * MIN_SIZE_RATIO, Math.abs(max) * MIN_SIZE_RATIO, MIN_SIZE);
  let res = 2 ** Math.ceil(Math.log2(range));

  // Make sure that our size is big enough, in case Math.log2() rounded our range down.

  while (res < range) {
    res *= 2;
  }

  return res;
};

const build = (lod: PathLevelOfDetail): void => {
  // Build our sizes for our ranges, and create our levels (see Note #6 above), unless we don't have any finite point.

  if (lod.xMin > lod.xMax) {
    return;
  }

  lod.xSize = size(lod.xMin, lod.xMax);
  lod.ySize = size(lod.yMin, lod.yMax);

  // Don't have any levels if one of our sizes is not finite (i.e. the range of our values is bigger than 2^1023), since
  // our values, once relative to our origin and divided by our tolerances, would then be 0 or NaN, i.e. all of the
  // points of our trace should be used.

  if (lod.xSize === Number.POSITIVE_INFINITY || lod.ySize === Number.POSITIVE_INFINITY) {
    return;
  }

  for (let level = 0; level < NB_OF_LEVELS; ++level) {
    lod.levels.push({
      indices: new Int32Array(64),
      count: 0,
      level,
      openEnd: false,
      processedCount: 0,
      snapshotIndex: -1,
      snapshotState: newState(),
      snapshotCount: 0
    });
  }
};

const isGap = (xValues: Float64Array, yValues: Float64Array, index: number): boolean => {
  // Return whether the given point is a gap, i.e. whether its X or Y value is not finite.
  // Note: we use x - x !== 0 to check whether x is not finite since it is faster than !Number.isFinite().

  const x = xValues[index] as number;
  const y = yValues[index] as number;

  return x - x !== 0 || y - y !== 0;
};

const reopenLevel = (level: PathLevel, xValues: Float64Array, yValues: Float64Array, from: number): number => {
  // Remove the points of the given level that may change because of the given point onwards (see Note #5 above), i.e.
  // its open end, if any, and its points from the point before the given one onwards, as well as its last gap, if it
  // ends with one (so that consecutive gaps still get replaced with the first of them), and return the index of the
  // last point that we keep, i.e. the anchor from which to resume, or -1 if we don't keep any point.
  // Note: the point before a gap is always one of our points (see processLevel()), so if we remove our last gap, then
  //       the last point that we keep is not a gap.

  if (level.openEnd) {
    --level.count;

    level.openEnd = false;
  }

  const indices = level.indices;
  let count = level.count;

  while (count > 0 && (indices[count - 1] as number) >= from - 1) {
    --count;
  }

  if (count > 0 && isGap(xValues, yValues, indices[count - 1] as number)) {
    --count;
  }

  level.count = count;

  return count > 0 ? (indices[count - 1] as number) : -1;
};

const appendIndex = (level: PathLevel, index: number): void => {
  // Append the given index to the given level, making sure that it has room for it.

  if (level.count === level.indices.length) {
    const indices = new Int32Array(2 * level.indices.length);

    indices.set(level.indices);

    level.indices = indices;
  }

  level.indices[level.count++] = index;
};

const scan = (
  lod: PathLevelOfDetail,
  xValues: Float64Array,
  yValues: Float64Array,
  count: number,
  maxNbOfPoints: number
): number => {
  // Take up to the given number of the given points into account (see update()), and return how many points we went
  // through (which, if our sizes need rebuilding, includes the points that we went through before rebuilding them).

  if (xValues !== lod.xValues || yValues !== lod.yValues) {
    invalidate(
      lod,
      isContinuationOf(xValues, lod.xValues) && isContinuationOf(yValues, lod.yValues) ? lod.count - 1 : 0
    );
  }

  lod.xValues = xValues;
  lod.yValues = yValues;

  let res = 0;

  while (lod.count < count && res < maxNbOfPoints) {
    // Extend our ranges with our next points, making our first finite point our origin (see Note #6 above).

    const start = lod.count;
    const end = Math.min(count, start + (maxNbOfPoints - res));
    let { xMin, xMax, yMin, yMax } = lod;

    for (let i = start; i < end; ++i) {
      const x = xValues[i] as number;
      const y = yValues[i] as number;

      if (x - x === 0 && y - y === 0) {
        if (x < xMin) {
          if (xMin === Number.POSITIVE_INFINITY) {
            lod.xOrigin = x;
            lod.yOrigin = y;
          }

          xMin = x;
        }

        if (x > xMax) {
          xMax = x;
        }

        if (y < yMin) {
          yMin = y;
        }

        if (y > yMax) {
          yMax = y;
        }
      }
    }

    res += end - start;

    lod.count = end;
    lod.xMin = xMin;
    lod.xMax = xMax;
    lod.yMin = yMin;
    lod.yMax = yMax;

    // Start again from scratch if our ranges have got bigger than our sizes, so that we rebuild our sizes (and
    // therefore our levels) for all of our points (see Note #6 above).

    if (lod.xSize !== 0 && (xMax - xMin > lod.xSize || yMax - yMin > lod.ySize)) {
      reset(lod);
    }
  }

  // Build our sizes (and therefore our levels) once we have taken all of our points into account, if we don't have them
  // yet (see Note #9 above).

  if (lod.xSize === 0 && lod.count >= count) {
    build(lod);
  }

  return res;
};

export const update = (lod: PathLevelOfDetail, xValues: Float64Array, yValues: Float64Array, count: number): void => {
  // Take the given points into account, from the first one that may have changed since we were last updated (see Note
  // #8 above), or that we haven't taken into account (see invalidate()), i.e. make sure that our sizes are big enough
  // for them, and rebuild our levels otherwise (see Note #6 above).
  // Note #1: our levels themselves only get updated when they are needed (see Note #5 above and updatedLevel()).
  // Note #2: the given number of points must not be smaller than the one we were last updated with for the same values
  //          (e.g., it is the length of the given values), since we would then keep our points beyond it.

  scan(lod, xValues, yValues, count, Number.POSITIVE_INFINITY);
};

const processLevel = (
  lod: PathLevelOfDetail,
  level: PathLevel,
  xValues: Float64Array,
  yValues: Float64Array,
  maxCount: number,
  maxNbOfPoints: number
): boolean => {
  // Process (up to the given number of) the points of our trace that the given level hasn't processed (see Note #5 and
  // Note #9 above), and return whether the level has no more than the given number of points, stopping as soon as it
  // has more (since it then gets dropped, see processedLevel()).
  // Note: the points that we process again (i.e. from our snapshot or from our anchor, see below) don't count towards
  //       the given number of points, so that we always process at least one new point.
  // Note: our state (see PathLevelState for what it means) is kept in local variables rather than in a PathLevelState
  //       object while we process our points, so that JavaScript engines can keep it in registers.

  const xOrigin = lod.xOrigin;
  const yOrigin = lod.yOrigin;
  const xScale = 4 ** level.level / lod.xSize; // Inverse of our X tolerance, which is exact since our sizes are powers
  const yScale = 4 ** level.level / lod.ySize; // of two (see Note #1 above).
  const snapshot = level.snapshotState;
  let state = STATE_NONE;
  let anchor = -1;
  let anchorU = 0;
  let anchorV = 0;
  let last = -1;
  let lastU = 0; // Position of last (our next anchor if our segment ends), which our snapshot doesn't keep.
  let lastV = 0;
  let maxSquaredDistance = 0;
  let fullCone = true;
  let rightX = 0;
  let rightY = 0;
  let leftX = 0;
  let leftY = 0;
  let start: number;

  // Reopen our level, i.e. restore its snapshot if we can, or remove its points that may change otherwise.

  if (level.snapshotIndex !== -1 && level.processedCount >= level.snapshotIndex) {
    level.count = level.snapshotCount;
    level.openEnd = false;

    state = snapshot.state;
    anchor = snapshot.anchor;
    anchorU = snapshot.anchorU;
    anchorV = snapshot.anchorV;
    last = snapshot.last;
    maxSquaredDistance = snapshot.maxSquaredDistance;
    fullCone = snapshot.fullCone;
    rightX = snapshot.rightX;
    rightY = snapshot.rightY;
    leftX = snapshot.leftX;
    leftY = snapshot.leftY;

    if (state === STATE_SEGMENT) {
      lastU = ((xValues[last] as number) - xOrigin) * xScale;
      lastV = ((yValues[last] as number) - yOrigin) * yScale;
    }

    start = level.snapshotIndex;
  } else {
    anchor = reopenLevel(level, xValues, yValues, level.processedCount);

    if (anchor !== -1) {
      state = STATE_SEGMENT;
      anchorU = ((xValues[anchor] as number) - xOrigin) * xScale;
      anchorV = ((yValues[anchor] as number) - yOrigin) * yScale;
      last = anchor;
      lastU = anchorU;
      lastV = anchorV;
    }

    start = anchor + 1;
  }

  // Process our points, taking a snapshot of our level just before the last one (so that we can resume from there,
  // whether we have processed all of our points or only some of them).

  const end = Math.min(lod.count, level.processedCount + maxNbOfPoints);

  for (let i = start; i < end; ++i) {
    if (i === end - 1) {
      level.snapshotIndex = i;
      level.snapshotCount = level.count;

      snapshot.state = state;
      snapshot.anchor = anchor;
      snapshot.anchorU = anchorU;
      snapshot.anchorV = anchorV;
      snapshot.last = last;
      snapshot.maxSquaredDistance = maxSquaredDistance;
      snapshot.fullCone = fullCone;
      snapshot.rightX = rightX;
      snapshot.rightY = rightY;
      snapshot.leftX = leftX;
      snapshot.leftY = leftY;
    }

    const x = xValues[i] as number;
    const y = yValues[i] as number;

    if (x - x !== 0 || y - y !== 0) {
      // A gap ends our segment, if any, and consecutive gaps are replaced with the first of them (see Note #4 above).

      if (state === STATE_SEGMENT && last !== anchor) {
        appendIndex(level, last);
      }

      if (state !== STATE_GAP) {
        appendIndex(level, i);

        state = STATE_GAP;
      }

      continue;
    }

    const u = (x - xOrigin) * xScale;
    const v = (y - yOrigin) * yScale;

    if (state !== STATE_SEGMENT) {
      // Our point is the first point of our trace or the first point after a gap, so it is our anchor.

      appendIndex(level, i);

      state = STATE_SEGMENT;
      anchor = i;
      anchorU = u;
      anchorV = v;
      last = i;
      lastU = u;
      lastV = v;
      maxSquaredDistance = 0;
      fullCone = true;

      continue;
    }

    // Check whether our point can be the end of our segment (see Note #2 and Note #3 above), i.e. whether it is within
    // our tolerance of our anchor and so are our previous points, or whether it is further than our tolerance from our
    // anchor, at least as far from it as our previous points that are beyond our tolerance, and within our cone (i.e.
    // counterclockwise of its right boundary and clockwise of its left boundary).

    let dx = u - anchorU;
    let dy = v - anchorV;
    let squaredDistance = dx * dx + dy * dy;

    if (
      squaredDistance <= 1
        ? maxSquaredDistance !== 0
        : squaredDistance < maxSquaredDistance ||
          (!fullCone && (rightX * dy - rightY * dx < 0 || dx * leftY - dy * leftX < 0))
    ) {
      // Our previous point becomes the end of our segment and the anchor of our next segment, which our point is then
      // always the end of (since our cone allows all directions and nothing is further than our point).

      appendIndex(level, last);

      if (level.count > maxCount) {
        return false;
      }

      anchor = last;
      anchorU = lastU;
      anchorV = lastV;
      maxSquaredDistance = 0;
      fullCone = true;

      dx = u - anchorU;
      dy = v - anchorV;
      squaredDistance = dx * dx + dy * dy;
    }

    // Make our point the end of our segment, and narrow our cone so that it keeps our point within our tolerance of our
    // segment, if our point is further than our tolerance from our anchor (see Note #3 above).

    last = i;
    lastU = u;
    lastV = v;

    if (squaredDistance > 1) {
      maxSquaredDistance = squaredDistance;

      // The boundaries of the directions that keep our point within our tolerance, i.e. the direction of our point
      // rotated by -asin(1 / distance) and asin(1 / distance), which we don't normalise since we only use them in cross
      // products (i.e. to know which side of a direction another direction is on). So, they are distance^2 long, i.e.
      // (dx * cos + dy * sin, dy * cos - dx * sin) * distance for our right boundary, with
      // cos = sqrt(distance^2 - 1) / distance and sin = 1 / distance.

      const scaledCos = Math.sqrt(squaredDistance - 1);
      const newRightX = dx * scaledCos + dy;
      const newRightY = dy * scaledCos - dx;
      const newLeftX = dx * scaledCos - dy;
      const newLeftY = dy * scaledCos + dx;

      if (fullCone) {
        fullCone = false;

        rightX = newRightX;
        rightY = newRightY;
        leftX = newLeftX;
        leftY = newLeftY;
      } else {
        // Our cone is the intersection of our previous cone and of those directions, i.e. the most counterclockwise of
        // their right boundaries and the most clockwise of their left boundaries (since both of them contain the
        // direction of our point and are less than half a turn wide).

        if (rightX * newRightY - rightY * newRightX > 0) {
          rightX = newRightX;
          rightY = newRightY;
        }

        if (newLeftX * leftY - newLeftY * leftX > 0) {
          leftX = newLeftX;
          leftY = newLeftY;
        }
      }
    }
  }

  // Add the end of our segment, if any, as an open end (since it may still be extended, see reopenLevel()).

  if (state === STATE_SEGMENT && last !== anchor) {
    appendIndex(level, last);

    level.openEnd = true;
  }

  level.processedCount = end;

  return level.count <= maxCount;
};

export const updatedLevel = (
  lod: PathLevelOfDetail,
  xValues: Float64Array,
  yValues: Float64Array,
  levelNumber: number
): PathLevel | undefined => {
  // Return the given level, once up to date for the points that we have taken into account (see Note #5 above), unless
  // we don't have it (e.g., if it got dropped, see Note #7 above).

  const level = lod.levels[levelNumber];

  if (!level || (level.processedCount < lod.count && !processedLevel(lod, level, xValues, yValues))) {
    return undefined;
  }

  return level;
};

const processedLevel = (
  lod: PathLevelOfDetail,
  level: PathLevel,
  xValues: Float64Array,
  yValues: Float64Array,
  maxNbOfPoints: number = Number.POSITIVE_INFINITY
): boolean => {
  // Process (up to the given number of) the points of our trace that the given level hasn't processed (see
  // processLevel()), and drop it, as well as our finer levels, if it hardly reduces the number of points of our trace
  // (see Note #7 above), and return whether we still have it.

  if (
    processLevel(
      lod,
      level,
      xValues,
      yValues,
      lod.count >= MIN_NB_OF_POINTS_TO_DROP_LEVELS ? MAX_LEVEL_RATIO * lod.count : Number.POSITIVE_INFINITY,
      maxNbOfPoints
    )
  ) {
    return true;
  }

  lod.levels.length = level.level;

  return false;
};

const levelNumber = (lod: PathLevelOfDetail, maxXTolerance: number, maxYTolerance: number): number => {
  // Return the number of our coarsest level whose tolerances are no bigger than the given ones (whether or not we have
  // that level), or -1 if we don't have sizes or if the given tolerances are not valid.

  if (lod.xSize === 0 || !(maxXTolerance > 0) || !(maxYTolerance > 0)) {
    return -1;
  }

  return Math.max(
    0,
    Math.ceil(0.5 * Math.log2(lod.xSize / maxXTolerance)),
    Math.ceil(0.5 * Math.log2(lod.ySize / maxYTolerance))
  );
};

export const selectLevel = (
  lod: PathLevelOfDetail,
  xValues: Float64Array,
  yValues: Float64Array,
  maxXTolerance: number,
  maxYTolerance: number
): PathLevel | undefined => {
  // Return our coarsest level whose tolerances are no bigger than the given ones, once up to date (see updatedLevel()),
  // if any (otherwise, all of the points of our trace should be used).
  // Note: our level of detail must have taken all of the points of our trace into account (see update()).

  const level = levelNumber(lod, maxXTolerance, maxYTolerance);

  return level === -1 ? undefined : updatedLevel(lod, xValues, yValues, level);
};

export const buildLevel = (
  lod: PathLevelOfDetail,
  xValues: Float64Array,
  yValues: Float64Array,
  count: number,
  maxXTolerance: number,
  maxYTolerance: number,
  maxNbOfPoints: number
): boolean => {
  // Do up to the given number of points of the work that selectLevel() would need for the given points and tolerances,
  // i.e. take those points into account (see update()) and then update the level that it would return (see
  // updatedLevel()), and return whether that work is all done, i.e. whether selectLevel() wouldn't need to do anything
  // anymore (see Note #9 above).
  // Note: the given number of points must not be smaller than the one we were last updated with for the same values
  //       (see update()).

  const nbOfPoints = scan(lod, xValues, yValues, count, maxNbOfPoints);

  if (lod.count < count) {
    return false;
  }

  const level = lod.levels[levelNumber(lod, maxXTolerance, maxYTolerance)];

  if (!level || level.processedCount >= lod.count) {
    return true;
  }

  if (nbOfPoints >= maxNbOfPoints) {
    return false;
  }

  return !processedLevel(lod, level, xValues, yValues, maxNbOfPoints - nbOfPoints) || level.processedCount >= lod.count;
};

const lowerBound = (indices: Int32Array, count: number, index: number): number => {
  // Return the position of the first of the given (sorted) indices that is not less than the given index, or the given
  // number of indices if there is none.

  let low = 0;
  let high = count;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((indices[middle] as number) < index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

export const coveringRange = (level: PathLevel, start: number, end: number): [start: number, end: number] => {
  // Return the range of the points of the given level (i.e. of their positions in its indices) that cover the points of
  // our trace from the given start (included) to the given end (excluded), i.e. from its last point that is not after
  // our first point (or its first point, if there is none) to its first point that is not before our last point (or its
  // last point, if there is none), so that its points in that range draw all of its segments that our points are on.

  return [
    Math.max(0, lowerBound(level.indices, level.count, start + 1) - 1),
    Math.min(level.count, lowerBound(level.indices, level.count, end - 1) + 1)
  ];
};
