// A path that gets split into several paths, so that none of them has more than a given number of points (see
// PlotWidget.vue). Indeed, Chrome (i.e. Skia) silently draws nothing for a path that has more than about 1,870,000
// points (e.g., an unsorted noisy trace of 10,000,000 points, which no level of detail can reduce), be it a Path2D or
// an SVG path element, while Firefox only strokes a path quickly if it has no more than a few thousand points (see
// linearPaths() in PlotWidget.vue).
// Note #1: if a polyline carries on in a new path, then that path starts with the last segment of the polyline (or its
//          last point, if it only has one point so far), so that the polyline gets drawn as if it was in one path (with
//          the same joins). A polyline that starts a new path has nothing to carry on from.
// Note #2: if a trace is faded (i.e. drawn with some transparency), then the parts of it that are in different paths
//          and that overlap (including the segment that a path carries on from, see Note #1) get painted more than
//          once, i.e. they look slightly less faded. This is only noticeable for a trace that has many more points than
//          its paths can have and that overlaps itself (e.g., noisy data whose X values are not sorted), and it is
//          still much better than drawing nothing (or drawing very slowly).

export const MAX_PATH_POINTS = 1_000_000;

const MIN_MAX_NB_OF_POINTS = 3; // A new path has up to two points from the previous one, plus at least a new one.

export interface ChunkablePath {
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
}

export interface ChunkedPath<T extends ChunkablePath> extends ChunkablePath {
  paths: T[]; // Our paths, to be drawn one after the other.
}

export const createChunkedPath = <T extends ChunkablePath>(
  newPath: () => T,
  maxNbOfPoints: number = MAX_PATH_POINTS
): ChunkedPath<T> => {
  // Return a path that adds its points to paths that it creates using the given function, so that none of them has
  // more than the given number of points (or MIN_MAX_NB_OF_POINTS points, if bigger, see Note #1 above).

  const maxPoints = Math.max(MIN_MAX_NB_OF_POINTS, maxNbOfPoints);
  let path = newPath();
  const paths = [path];
  let nbOfPoints = 0;
  let nbOfPolylinePoints = 0;
  let previousX = 0;
  let previousY = 0;
  let lastX = 0;
  let lastY = 0;

  const newPathIfNeeded = (): void => {
    // Create a new path if our current one is full, carrying on from the last segment of our current polyline, if any
    // (see Note #1 above).

    if (nbOfPoints < maxPoints) {
      return;
    }

    path = newPath();
    nbOfPoints = 0;

    paths.push(path);

    if (nbOfPolylinePoints > 1) {
      path.moveTo(previousX, previousY);
      path.lineTo(lastX, lastY);

      nbOfPoints = 2;
    } else if (nbOfPolylinePoints === 1) {
      path.moveTo(lastX, lastY);

      nbOfPoints = 1;
    }
  };

  return {
    paths,
    moveTo: (x: number, y: number) => {
      // We start a new polyline, so we have nothing to carry on from if we need a new path.

      nbOfPolylinePoints = 0;

      newPathIfNeeded();

      path.moveTo(x, y);

      ++nbOfPoints;
      nbOfPolylinePoints = 1;
      lastX = x;
      lastY = y;
    },
    lineTo: (x: number, y: number) => {
      newPathIfNeeded();

      path.lineTo(x, y);

      ++nbOfPoints;
      ++nbOfPolylinePoints;
      previousX = lastX;
      previousY = lastY;
      lastX = x;
      lastY = y;
    }
  };
};
