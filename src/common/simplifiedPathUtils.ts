// A path that simplifies the polylines that get added to it before adding them to another path, so that they get drawn
// within a given tolerance of what they would otherwise look like, but using fewer segments (see PlotWidget.vue).
// Note #1: stroking a trace costs about the same for each of its segments (e.g., because of its round joins), whatever
//          their length. Our path builder (see linearPath() in PlotWidget.vue) draws up to four points per pixel
//          column, so a smooth trace that spans our plotting area gets drawn using thousands of segments, even though a
//          few hundred of them would make it look the same (e.g., within a quarter of a canvas pixel). So, we simplify
//          the polylines of a trace in pixels, as they get drawn, which costs O(number of points) and needs no memory.
// Note #2: we use the same algorithm as our path level of detail (see Note #2 and Note #3 of
//          pathLevelOfDetailUtils.ts), i.e. consecutive points are replaced with a segment, from the first to the last
//          of them, as long as all of them are within our tolerance of that segment. This means that the first and
//          last points of a polyline are always kept, as is any point that a polyline doesn't go (nearly) straight
//          through (e.g., a peak of noisy data, which is therefore drawn as is).
// Note #3: a polyline gets added to our path as soon as it starts (i.e. using moveTo()), but the end of its last
//          segment only gets added once we know that it is its last point, i.e. once another polyline starts or once
//          end() gets called, which must therefore be called once all of our polylines have been added.
// Note #4: with a tolerance of zero, our polylines get added to our path as they are. This allows PlotWidget.vue to
//          always give a SimplifiedPath to its path builder, whether or not it simplifies a trace, so that the calls
//          that its path builder makes for (almost) every point of a trace always go to the same kind of object,
//          which JavaScript engines handle faster (e.g., noisy traces get drawn up to about 20% faster in Chrome).
// Note #5: we may be given a maximum number of points, in which case we stop simplifying our polylines (and add the
//          rest of their points as they are) as soon as we have added more points than that to our path. This allows
//          PlotWidget.vue to find out cheaply that a trace is not worth simplifying (e.g., noisy data, for which we
//          would otherwise add nearly all of its points, after having spent time trying to simplify it).
// Note #6: whether simplifying our polylines was worth it is a matter of how many of the points that we were given we
//          added to our path (see reducedTo()), not how many points the polylines of a trace could have had (e.g., a
//          path builder skips the points of a trace that cannot be seen, so a noisy trace that is zoomed in would
//          otherwise look worth simplifying).

import type { ChunkablePath } from './chunkedPathUtils';

export class SimplifiedPath implements ChunkablePath {
  // Note: our state is kept in fields (rather than in variables captured by closures), so that JavaScript engines can
  //       access it quickly, since lineTo() gets called for (almost) every point of a trace.

  nbOfPoints = 0; // Number of points that we have added to our path.
  nbOfGivenPoints = 0; // Number of points that we were given while simplifying our polylines (see Note #6 above).

  private readonly path: ChunkablePath; // The path to which we add our simplified polylines.
  private readonly scale: number; // Inverse of our tolerance, so that our tolerance is one once scaled.
  private readonly maxNbOfPoints: number; // Number of points beyond which we stop simplifying (see Note #5 above).
  private simplifies: boolean; // Whether we simplify our polylines (see Note #4 and Note #5 above).
  private hasPolyline = false; // Whether we have a polyline in progress.
  private hasSegment = false; // Whether our polyline has a segment in progress, i.e. a last point besides our anchor.
  private anchorX = 0; // Start of our segment, i.e. the last point of our polyline that we have added to our path.
  private anchorY = 0;
  private lastX = 0; // End of our segment, i.e. our next anchor if our segment has to end.
  private lastY = 0;
  private maxSquaredDistance = 0; // Scaled squared distance between our anchor and the furthest point of our segment.
  private fullCone = true; // Whether our cone still allows all directions (see Note #3 of pathLevelOfDetailUtils.ts).
  private rightX = 0; // Right boundary of our cone.
  private rightY = 0;
  private leftX = 0; // Left boundary of our cone.
  private leftY = 0;

  constructor(path: ChunkablePath, tolerance: number, maxNbOfPoints: number = Number.POSITIVE_INFINITY) {
    this.path = path;
    this.scale = 1 / tolerance;
    this.maxNbOfPoints = maxNbOfPoints;
    this.simplifies = tolerance > 0;
  }

  moveTo(x: number, y: number): void {
    // End our current polyline, if any, and start a new one from the given point, which is our anchor.

    this.end();

    this.path.moveTo(x, y);

    ++this.nbOfPoints;

    if (this.simplifies) {
      ++this.nbOfGivenPoints;
    }

    this.hasPolyline = true;
    this.anchorX = x;
    this.anchorY = y;
    this.maxSquaredDistance = 0;
    this.fullCone = true;
  }

  lineTo(x: number, y: number): void {
    // Add the given point as is if we don't simplify our polylines (see Note #4 and Note #5 above) and have a polyline
    // in progress, and simplify it otherwise.
    // Note: this is all that we do for (almost) every point of a trace that we don't simplify, so we keep it small,
    //       which makes it much cheaper to call (e.g., panning 100 noisy traces of 1,000 points is about 15% faster in
    //       Chrome than if our point was added by simplifiedLineTo()).

    if (this.simplifies || !this.hasPolyline) {
      this.simplifiedLineTo(x, y);

      return;
    }

    this.path.lineTo(x, y);

    ++this.nbOfPoints;
  }

  private simplifiedLineTo(x: number, y: number): void {
    // Like a canvas, start a polyline from the given point if we don't have one, and otherwise simplify our polyline
    // with our point.

    if (!this.hasPolyline) {
      this.moveTo(x, y);

      return;
    }

    ++this.nbOfGivenPoints;

    // Check whether our point can be the end of our segment (see Note #2 and Note #3 of pathLevelOfDetailUtils.ts),
    // i.e. whether it is within our tolerance of our anchor and so are our previous points, or whether it is further
    // than our tolerance from our anchor, at least as far from it as our previous points that are beyond our tolerance,
    // and within our cone (i.e. counterclockwise of its right boundary and clockwise of its left boundary).

    const scale = this.scale;
    let dx = (x - this.anchorX) * scale;
    let dy = (y - this.anchorY) * scale;
    let squaredDistance = dx * dx + dy * dy;

    if (
      squaredDistance <= 1
        ? this.maxSquaredDistance !== 0
        : squaredDistance < this.maxSquaredDistance ||
          (!this.fullCone && (this.rightX * dy - this.rightY * dx < 0 || dx * this.leftY - dy * this.leftX < 0))
    ) {
      // Our previous point becomes the end of our segment and the anchor of our next segment, which our point is then
      // always the end of (since our cone allows all directions and nothing is further than our point).
      // Note: our previous point cannot be our anchor since our anchor alone (i.e. a maximum squared distance of zero
      //       and a full cone) never ends our segment.

      this.path.lineTo(this.lastX, this.lastY);

      ++this.nbOfPoints;

      // Stop simplifying, if we have added too many points to our path (see Note #5 above), i.e. add our point as is.

      if (this.nbOfPoints > this.maxNbOfPoints) {
        this.path.lineTo(x, y);

        ++this.nbOfPoints;

        this.simplifies = false;
        this.hasSegment = false;

        return;
      }

      this.anchorX = this.lastX;
      this.anchorY = this.lastY;
      this.maxSquaredDistance = 0;
      this.fullCone = true;

      dx = (x - this.anchorX) * scale;
      dy = (y - this.anchorY) * scale;
      squaredDistance = dx * dx + dy * dy;
    }

    // Make our point the end of our segment, and narrow our cone so that it keeps our point within our tolerance of our
    // segment, if our point is further than our tolerance from our anchor (see Note #3 of pathLevelOfDetailUtils.ts).

    this.hasSegment = true;
    this.lastX = x;
    this.lastY = y;

    if (squaredDistance > 1) {
      this.maxSquaredDistance = squaredDistance;

      // The boundaries of the directions that keep our point within our tolerance (see processLevel() in
      // pathLevelOfDetailUtils.ts).

      const scaledCos = Math.sqrt(squaredDistance - 1);
      const newRightX = dx * scaledCos + dy;
      const newRightY = dy * scaledCos - dx;
      const newLeftX = dx * scaledCos - dy;
      const newLeftY = dy * scaledCos + dx;

      if (this.fullCone) {
        this.fullCone = false;
        this.rightX = newRightX;
        this.rightY = newRightY;
        this.leftX = newLeftX;
        this.leftY = newLeftY;
      } else {
        if (this.rightX * newRightY - this.rightY * newRightX > 0) {
          this.rightX = newRightX;
          this.rightY = newRightY;
        }

        if (newLeftX * this.leftY - newLeftY * this.leftX > 0) {
          this.leftX = newLeftX;
          this.leftY = newLeftY;
        }
      }
    }
  }

  reducedTo(maxRatio: number): boolean {
    // Return whether we have simplified our polylines all along (see Note #5 above) and added at most the given
    // fraction of the points that we were given to our path (see Note #6 above).

    return this.simplifies && this.nbOfPoints <= maxRatio * this.nbOfGivenPoints;
  }

  end(): void {
    // Add the end of our current segment, if any, to our path, and end our current polyline (see Note #3 above).

    if (this.hasSegment) {
      this.path.lineTo(this.lastX, this.lastY);

      ++this.nbOfPoints;
    }

    this.hasPolyline = false;
    this.hasSegment = false;
  }
}
