// The outline of the stroke of a polyline whose X values are non-decreasing (i.e. an x-monotone polyline, e.g. a trace
// whose X values are sorted), i.e. polygons that cover exactly what stroking that polyline (with round joins and butt
// caps) would cover, so that they can be filled rather than the polyline stroked (see linearPaths() in PlotWidget.vue).
// Note #1: Firefox strokes a wide polyline that overlaps itself a lot very slowly (e.g., the vertical zig-zag that our
//          level of detail keeps in each pixel column of a noisy trace, see levelOfDetailUtils.ts), whether or not its
//          canvas is accelerated, while it fills a polygon that doesn't overlap itself quickly.
// Note #2: the stroke of a polyline is the union of a rectangle around each of its segments (whose ends are its butt
//          ends) and of a join at each of its interior vertices, i.e. the sector of the disk of radius r (i.e. half
//          our line width) centred on that vertex that goes from the outer edge of one of its segments to the outer
//          edge of the other (see the HTML specification of the stroke of a path). It is within the set of points that
//          are within r of our polyline, and it only differs from it within r of the ends of our polyline. Indeed, if
//          the distance from a point to a point moving along our polyline has a local minimum (of at most r) that is
//          not at one of the ends of our polyline, then our point is in the rectangle of the segment where that minimum
//          is or in the join of the vertex where it is. Otherwise, that distance is smallest at one of the ends of our
//          polyline, i.e. our point is within r of that end.
//          Note: this is why we can't use the whole disk of a vertex that is far from the ends of our polyline along
//                our polyline, but close to one of them in X. For example, the stroke of a tiny zig-zag that moves away
//                from a point has gaps between the rectangles of its segments, which fan out away from it.
// Note #3: so, the set of points that are within r of the part of our polyline whose vertices are at least 2r away from
//          both of its ends in X (i.e. its body, all of whose points are then at least 2r away from both ends of our
//          polyline, since our polyline is x-monotone) is within our stroke. That set of points is the union of a
//          rectangle around each of the segments of our body and of the whole disk of each of its vertices (i.e. its
//          ends are round), and every vertical line crosses it in a single interval (since our body is x-monotone). So,
//          it is the region between a top boundary T(x) and a bottom boundary B(x), i.e. a polygon that doesn't overlap
//          itself: T(x) from left to right, and then B(x) from right to left. The rest of our stroke, i.e. the
//          rectangles of the segments and the joins of the vertices that are not part of our body (i.e. near the butt
//          ends of our polyline, which can make a vertical line cross our stroke more than once), are added as polygons
//          of their own, with the same orientation as our body, so that the union of all of our polygons gets filled.
// Note #4: T(x) is the lower envelope (i.e. the minimum, since Y goes down) of the upper arcs of the disks of the
//          vertices of our body and of the upper offset edges of its segments (i.e. its segments offset by r upwards).
//          B(x) is the same for our body mirrored vertically, i.e. with its Y values negated.
// Note #5: we build T(x) in three steps:
//           1. the lower envelope of the upper arcs of our disks, which have the same radius and are sorted by X value,
//              so that two of them cross at most once, using a monotone stack, i.e. in amortised O(1) per vertex;
//           2. the upper offset edges of our segments that may be below that envelope somewhere. Indeed, an edge minus
//              an arc is concave, so if an edge is not below an arc at both ends of their overlap, then it is nowhere
//              below it. This means that most of the edges of a dense trace get rejected without having to compute
//              where they cross an arc; and
//           3. the insertion of our remaining edges into our envelope, in X order (so that they get inserted near its
//              end), computing where they cross what they overlap.
// Note #6: we add our arcs to our path as cubic Bézier curves (rather than using arcTo()), since Skia (used by Chrome
//          and Firefox) stores the points of a path as 32-bit floats and computes an arcTo() from its current point, so
//          that chained arcTo() calls can drift by tens of pixels (e.g., leaving holes in a filled outline). A cubic
//          Bézier curve is within 2.7e-4 r of a quarter turn of a circle, and even closer to a smaller arc.
// Note #7: like our levels of detail, we use typed arrays that we only ever grow and keep, so that building an outline
//          (e.g., every time a plot gets drawn) doesn't allocate any memory once our arrays are big enough.

export interface StrokeOutlinePath {
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  bezierCurveTo: (cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) => void;
  closePath: () => void;
}

const ARC = 0; // y = b - sqrt(r^2 - (x - a)^2), i.e. the upper arc of the circle of radius r centred on (a, b).
const LINE = 1; // y = b + (x - a) * d, over [a, c].
const NONE = -1; // No piece, i.e. a gap in our envelope.
const MIN_WIDTH = 1e-9; // Width (in pixels) below which a part of our envelope is ignored.
const MIN_INITIAL_CAPACITY = 256;

let radius = 1;
let radius2 = 1;

const grownFloat64Array = (array: Float64Array, capacity: number): Float64Array<ArrayBuffer> => {
  const res = new Float64Array(capacity);

  res.set(array);

  return res;
};

const grownInt32Array = (array: Int32Array, capacity: number): Int32Array<ArrayBuffer> => {
  const res = new Int32Array(capacity);

  res.set(array);

  return res;
};

// Our points, i.e. those of the polyline that we outline, without consecutive duplicates (since a zero-length segment
// doesn't get stroked).

let pointXs = new Float64Array(0);
let pointYs = new Float64Array(0);
let nbOfPoints = 0;

// Our pieces (see the comments of ARC and LINE above).

let pieceKinds = new Uint8Array(0);
let pieceAs = new Float64Array(0);
let pieceBs = new Float64Array(0);
let pieceCs = new Float64Array(0);
let pieceDs = new Float64Array(0);
let nbOfPieces = 0;

const addPiece = (kind: number, a: number, b: number, c: number, d: number): number => {
  if (nbOfPieces === pieceKinds.length) {
    const capacity = Math.max(MIN_INITIAL_CAPACITY, 2 * nbOfPieces);
    const kinds = new Uint8Array(capacity);

    kinds.set(pieceKinds);

    pieceKinds = kinds;
    pieceAs = grownFloat64Array(pieceAs, capacity);
    pieceBs = grownFloat64Array(pieceBs, capacity);
    pieceCs = grownFloat64Array(pieceCs, capacity);
    pieceDs = grownFloat64Array(pieceDs, capacity);
  }

  pieceKinds[nbOfPieces] = kind;
  pieceAs[nbOfPieces] = a;
  pieceBs[nbOfPieces] = b;
  pieceCs[nbOfPieces] = c;
  pieceDs[nbOfPieces] = d;

  return nbOfPieces++;
};

const arcValue = (cx: number, cy: number, x: number): number => {
  const dx = x - cx;
  const h = radius2 - dx * dx;

  return cy - (h > 0 ? Math.sqrt(h) : 0);
};

const value = (piece: number, x: number): number => {
  if (pieceKinds[piece] === ARC) {
    return arcValue(pieceAs[piece] as number, pieceBs[piece] as number, x);
  }

  return (pieceBs[piece] as number) + (x - (pieceAs[piece] as number)) * (pieceDs[piece] as number);
};

const upperCrossing = (x0: number, y0: number, x1: number, y1: number): number => {
  // Return the X value of the upper intersection of the circles (of radius r) centred on the given points, which must
  // be less than 2r apart. Their intersections are on the perpendicular bisector of their centres, at
  // sqrt(r^2 - d^2 / 4) from their middle, i.e. at (mx - h dy, my + h dx) and (mx + h dy, my - h dx) where
  // h = sqrt(r^2 / d^2 - 1 / 4), and the upper one is the one with the smaller Y value.

  const dx = x1 - x0;
  const dy = y1 - y0;
  const h = Math.sqrt(Math.max(0, radius2 / (dx * dx + dy * dy) - 0.25));

  return dx < 0 ? x0 + 0.5 * dx - h * dy : x0 + 0.5 * dx + h * dy;
};

// Step 1: the lower envelope of the upper arcs of the disks of our vertices, as a monotone stack (see Note #5 above),
// i.e. stack entry k is arc stackPieces[k] from stackStarts[k] to stackStarts[k + 1] or to the end of its arc,
// whichever comes first.

let stackPieces = new Int32Array(0);
let stackStarts = new Float64Array(0);
let stackSize = 0;

const pushStack = (cx: number, cy: number, from: number): void => {
  if (stackSize === stackPieces.length) {
    const capacity = Math.max(MIN_INITIAL_CAPACITY, 2 * stackSize);

    stackPieces = grownInt32Array(stackPieces, capacity);
    stackStarts = grownFloat64Array(stackStarts, capacity);
  }

  stackPieces[stackSize] = addPiece(ARC, cx, cy, 0, 0);
  stackStarts[stackSize] = from;

  ++stackSize;
};

const pushArc = (cx: number, cy: number): void => {
  // Add the upper arc of the disk centred on the given point, whose X value is not less than that of our previous arcs,
  // to our stack.
  // Note: if two arcs (of the same radius) cross, then the one whose centre is on the left is below the other one on
  //       the left of their crossing, and above it on its right.

  const start = cx - radius;

  while (stackSize > 0) {
    const top = stackPieces[stackSize - 1] as number;
    const topX = pieceAs[top] as number;
    const topY = pieceBs[top] as number;
    const topStart = stackStarts[stackSize - 1] as number;
    const topEnd = topX + radius;

    // Our arc doesn't overlap the top one, so it simply comes after it.

    if (start >= topEnd) {
      break;
    }

    // Our arc has the same centre X value as the top one, so one of them is below the other one everywhere.

    if (cx === topX) {
      if (cy < topY) {
        --stackSize;

        continue;
      }

      return;
    }

    // Our arc is below the top one from where their overlap starts (in which case the top one doesn't contribute to
    // our envelope anymore if our arc covers all of its part of our envelope), from where they cross, or only after
    // the top one ends.

    const overlapStart = Math.max(start, topStart);

    if (arcValue(cx, cy, overlapStart) <= arcValue(topX, topY, overlapStart)) {
      if (start <= topStart) {
        --stackSize;

        continue;
      }

      pushStack(cx, cy, start);

      return;
    }

    pushStack(cx, cy, arcValue(cx, cy, topEnd) < topY ? upperCrossing(topX, topY, cx, cy) : topEnd);

    return;
  }

  pushStack(cx, cy, start);
};

const stackEntryEnd = (k: number): number => {
  const arcEnd = (pieceAs[stackPieces[k] as number] as number) + radius;

  return k + 1 < stackSize ? Math.min(stackStarts[k + 1] as number, arcEnd) : arcEnd;
};

// Step 2: the upper offset edges of our segments that may be below the envelope of our arcs (see Note #5 above), i.e.
// those that we need to insert into our envelope.

let insertedPieces = new Int32Array(0);
let nbOfInsertedPieces = 0;
let searchIndex = 0;

const addInsertedPiece = (piece: number): void => {
  if (nbOfInsertedPieces === insertedPieces.length) {
    insertedPieces = grownInt32Array(insertedPieces, Math.max(MIN_INITIAL_CAPACITY, 2 * nbOfInsertedPieces));
  }

  insertedPieces[nbOfInsertedPieces++] = piece;
};

const mayBeBelowArcs = (x0: number, y0: number, x1: number, y1: number): boolean => {
  // Return whether the given line may be below the envelope of our arcs somewhere, i.e. whether it is below one of its
  // arcs at one of the ends of their overlap (see Note #5 above), or whether it overlaps a gap in it.
  // Note: our line is the offset edge of one of our segments, so it is within our envelope, which goes from r before
  //       our first vertex to r after our last one.

  // Find the stack entry that contains x0, starting from where we last were, since our lines come (nearly) in X order.

  let k = Math.min(searchIndex, stackSize - 1);

  while (k > 0 && (stackStarts[k] as number) > x0) {
    --k;
  }

  while (k + 1 < stackSize && (stackStarts[k + 1] as number) <= x0) {
    ++k;
  }

  searchIndex = k;

  const slope = (y1 - y0) / (x1 - x0);

  for (; k < stackSize; ++k) {
    const start = stackStarts[k] as number;

    if (start >= x1) {
      return false;
    }

    const piece = stackPieces[k] as number;
    const cx = pieceAs[piece] as number;
    const cy = pieceBs[piece] as number;
    const end = stackEntryEnd(k);
    const lo = Math.max(x0, start);
    const hi = Math.min(x1, end);

    if (hi > lo && (y0 + (lo - x0) * slope < arcValue(cx, cy, lo) || y0 + (hi - x0) * slope < arcValue(cx, cy, hi))) {
      return true;
    }

    // A gap after this entry, within our line.

    if (end < x1 && (k + 1 === stackSize || (stackStarts[k + 1] as number) > end + MIN_WIDTH)) {
      return true;
    }
  }

  return false;
};

// Step 3: our envelope, into which we insert our remaining edges (see Note #5 above), i.e. entry k is piece
// entryPieces[k] (or NONE) from entryStarts[k] to entryStarts[k + 1] (or envelopeEnd).

let entryPieces = new Int32Array(0);
let entryStarts = new Float64Array(0);
let nbOfEntries = 0;
let envelopeEnd = Number.NEGATIVE_INFINITY;

const ensureEntryCapacity = (capacity: number): void => {
  if (capacity > entryPieces.length) {
    const newCapacity = Math.max(MIN_INITIAL_CAPACITY, capacity, 2 * entryPieces.length);

    entryPieces = grownInt32Array(entryPieces, newCapacity);
    entryStarts = grownFloat64Array(entryStarts, newCapacity);
  }
};

const appendEntry = (piece: number, start: number, end: number): void => {
  // Append the given piece, over [start, end], to our envelope, which must not extend beyond start (beyond MIN_WIDTH),
  // with a gap before it, if needed. A piece that is (almost) empty (e.g., the arc of a vertex whose X value is almost
  // that of the previous one) is ignored.

  if (end - start < MIN_WIDTH) {
    return;
  }

  ensureEntryCapacity(nbOfEntries + 2);

  let entryStart = start;

  if (nbOfEntries > 0) {
    if (start > envelopeEnd + MIN_WIDTH) {
      entryPieces[nbOfEntries] = NONE;
      entryStarts[nbOfEntries] = envelopeEnd;

      ++nbOfEntries;
    } else {
      entryStart = envelopeEnd;
    }
  }

  entryPieces[nbOfEntries] = piece;
  entryStarts[nbOfEntries] = entryStart;

  ++nbOfEntries;

  envelopeEnd = end;
};

// The entries that replace the end of our envelope when we insert a piece into it.

let newPieces = new Int32Array(0);
let newStarts = new Float64Array(0);
let nbOfNewEntries = 0;

const pushNewEntry = (piece: number, start: number): void => {
  // Add the given entry to our new entries, merging it with our last one if it is for the same piece.
  // Note: an entry may be (almost) empty (e.g., between two crossings that are almost the same), in which case it gets
  //       ignored when we add our envelope to a path.

  if (nbOfNewEntries > 0 && newPieces[nbOfNewEntries - 1] === piece) {
    return;
  }

  if (nbOfNewEntries === newPieces.length) {
    const capacity = Math.max(MIN_INITIAL_CAPACITY, 2 * nbOfNewEntries);

    newPieces = grownInt32Array(newPieces, capacity);
    newStarts = grownFloat64Array(newStarts, capacity);
  }

  newPieces[nbOfNewEntries] = piece;
  newStarts[nbOfNewEntries] = start;

  ++nbOfNewEntries;
};

const crossings = new Float64Array(2);

const crossingsOf = (p: number, q: number, lo: number, hi: number): number => {
  // Put, in crossings (sorted), the X values within ]lo, hi[ where line p and piece q cross, and return how many there
  // are.

  let res = 0;

  if (pieceKinds[q] === LINE) {
    // Two lines cross at most once.

    const slopeDifference = (pieceDs[p] as number) - (pieceDs[q] as number);

    if (slopeDifference !== 0) {
      const x =
        ((pieceBs[q] as number) -
          (pieceBs[p] as number) +
          (pieceAs[p] as number) * (pieceDs[p] as number) -
          (pieceAs[q] as number) * (pieceDs[q] as number)) /
        slopeDifference;

      if (x > lo && x < hi) {
        crossings[res++] = x;
      }
    }
  } else {
    // A line and an upper arc cross where (x - cx)^2 + (d x + k)^2 = r^2 (with y - cy = d x + k on our line) and
    // y <= cy, i.e. at most twice.

    const cx = pieceAs[q] as number;
    const d = pieceDs[p] as number;
    const k = (pieceBs[p] as number) - (pieceAs[p] as number) * d - (pieceBs[q] as number);
    const a = 1 + d * d;
    const b = 2 * (d * k - cx);
    const c = cx * cx + k * k - radius2;
    const discriminant = b * b - 4 * a * c;

    if (discriminant > 0) {
      // Compute our roots in a numerically stable way.

      const sqrtDiscriminant = Math.sqrt(discriminant);
      const q2 = -0.5 * (b + (b >= 0 ? sqrtDiscriminant : -sqrtDiscriminant));
      const root1 = Math.min(q2 / a, c / q2);
      const root2 = Math.max(q2 / a, c / q2);

      if (root1 > lo && root1 < hi && d * root1 + k <= 0) {
        crossings[res++] = root1;
      }

      if (root2 > lo && root2 < hi && d * root2 + k <= 0 && root2 !== root1) {
        crossings[res++] = root2;
      }
    }
  }

  return res;
};

const isNowhereBelow = (p: number, q: number, lo: number, hi: number): boolean => {
  // Return whether line p is nowhere below piece q over [lo, hi].
  // Note: an arc is convex (since Y goes down), so a line minus an arc (or a line) is concave, i.e. if p is not below q
  //       at both ends of [lo, hi], then it is nowhere below it.

  return value(p, lo) >= value(q, lo) && value(p, hi) >= value(q, hi);
};

const insertOverlap = (p: number, q: number, lo: number, hi: number): void => {
  // Add, to our new entries, line p where it is below piece q over [lo, hi], and piece q elsewhere.
  // Note: p and q don't cross between two consecutive crossings, so one of them is below the other one there, except
  //       where they touch (e.g., a line that is tangent to an arc), which is why we compare them at three points.

  if (isNowhereBelow(p, q, lo, hi)) {
    pushNewEntry(q, lo);

    return;
  }

  const nbOfCrossings = crossingsOf(p, q, lo, hi);
  let start = lo;

  for (let i = 0; i <= nbOfCrossings; ++i) {
    const end = i < nbOfCrossings ? (crossings[i] as number) : hi;
    let difference = 0;

    for (let j = 1; j <= 3; ++j) {
      const x = start + 0.25 * j * (end - start);

      difference += value(p, x) - value(q, x);
    }

    pushNewEntry(difference < 0 ? p : q, start);

    start = end;
  }
};

const insert = (p: number, start: number, end: number): void => {
  // Insert line p, over [start, end], into our envelope, which must already cover it (see buildEnvelope()), although
  // we clamp it to our envelope in case of rounding errors.

  const s = Math.max(start, entryStarts[0] as number);
  const e = Math.min(end, envelopeEnd);

  if (e - s < MIN_WIDTH) {
    return;
  }

  // Find the first entry that overlaps [s, e], i.e. the last one that starts at or before s.

  let k = nbOfEntries - 1;

  while (k > 0 && (entryStarts[k] as number) > s) {
    --k;
  }

  // Determine the entries that replace ours from k onwards.

  nbOfNewEntries = 0;

  for (let j = k; j < nbOfEntries; ++j) {
    const q = entryPieces[j] as number;
    const qStart = entryStarts[j] as number;
    const qEnd = j + 1 < nbOfEntries ? (entryStarts[j + 1] as number) : envelopeEnd;
    const lo = Math.max(s, qStart);
    const hi = Math.min(e, qEnd);

    if (hi <= lo) {
      pushNewEntry(q, qStart);

      continue;
    }

    if (qStart < lo) {
      pushNewEntry(q, qStart);
    }

    if (q === NONE) {
      pushNewEntry(p, lo);
    } else {
      insertOverlap(p, q, lo, hi);
    }

    if (hi < qEnd) {
      pushNewEntry(q, hi);
    }
  }

  // Replace our entries.

  ensureEntryCapacity(k + nbOfNewEntries);

  entryPieces.set(newPieces.subarray(0, nbOfNewEntries), k);
  entryStarts.set(newStarts.subarray(0, nbOfNewEntries), k);

  nbOfEntries = k + nbOfNewEntries;
};

const sortInsertedPieces = (): void => {
  // Sort the edges that we need to insert by where they start, using an insertion sort since they come nearly sorted.

  for (let i = 1; i < nbOfInsertedPieces; ++i) {
    const piece = insertedPieces[i] as number;
    const start = pieceAs[piece] as number;
    let j = i - 1;

    while (j >= 0 && (pieceAs[insertedPieces[j] as number] as number) > start) {
      insertedPieces[j + 1] = insertedPieces[j] as number;

      --j;
    }

    insertedPieces[j + 1] = piece;
  }
};

const buildEnvelope = (sign: number, first: number, last: number): void => {
  // Build the top envelope of the set of points within r of our polyline from point first to point last (included),
  // i.e. of our body (see Note #3 above), with a sign of 1, or that of its mirror image, i.e. its bottom envelope with
  // negated Y values, with a sign of -1 (see Note #4 above).

  nbOfPieces = 0;
  stackSize = 0;
  nbOfInsertedPieces = 0;
  searchIndex = 0;
  nbOfEntries = 0;
  envelopeEnd = Number.NEGATIVE_INFINITY;

  const xs = pointXs;
  const ys = pointYs;
  const r = radius;

  // Step 1: the disks of our vertices.

  for (let i = first; i <= last; ++i) {
    pushArc(xs[i] as number, sign * (ys[i] as number));
  }

  // Step 2: the upper offset edges of our segments that may be below our arcs.

  for (let i = first; i < last; ++i) {
    const x0 = xs[i] as number;
    const y0 = sign * (ys[i] as number);
    const dx = (xs[i + 1] as number) - x0;

    if (dx > 0) {
      const dy = sign * (ys[i + 1] as number) - y0;
      const length = Math.hypot(dx, dy);
      const nx = (r * dy) / length; // Upward normal of our segment (scaled to r), i.e. with a negative Y component.
      const ny = (-r * dx) / length;

      if (mayBeBelowArcs(x0 + nx, y0 + ny, x0 + dx + nx, y0 + dy + ny)) {
        addInsertedPiece(addPiece(LINE, x0 + nx, y0 + ny, x0 + dx + nx, dy / dx));
      }
    }
  }

  // Step 3: our envelope, i.e. the entries of our stack and our remaining edges, in X order.

  sortInsertedPieces();

  let k = 0;

  for (let i = 0; i <= nbOfInsertedPieces; ++i) {
    const piece = i < nbOfInsertedPieces ? (insertedPieces[i] as number) : NONE;
    const pieceEnd = piece === NONE ? Number.POSITIVE_INFINITY : (pieceCs[piece] as number);

    // Append the entries of our stack that start before our edge ends, so that our envelope covers our edge.
    // Note: our edge ends on the circle of the next vertex, which our stack covers, so this appends the entry of our
    //       stack that covers the end of our edge. Also, our envelope ends where the last entry that we appended ends
    //       (since our edges get inserted within our envelope), so the entries that we append never overlap it.

    for (; k < stackSize && (stackStarts[k] as number) < pieceEnd; ++k) {
      appendEntry(stackPieces[k] as number, stackStarts[k] as number, stackEntryEnd(k));
    }

    if (piece !== NONE) {
      insert(piece, pieceAs[piece] as number, pieceEnd);
    }
  }
};

// The addition of our polygons to a path (see Note #6 above).

let currentX = Number.NaN;
let currentY = Number.NaN;

const moveTo = (path: StrokeOutlinePath, x: number, y: number): void => {
  path.moveTo(x, y);

  currentX = x;
  currentY = y;
};

const lineTo = (path: StrokeOutlinePath, x: number, y: number): void => {
  if (x !== currentX || y !== currentY) {
    path.lineTo(x, y);

    currentX = x;
    currentY = y;
  }
};

const arcTo = (
  path: StrokeOutlinePath,
  cx: number,
  cy: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): void => {
  // Add the arc of the circle (of radius r) centred on (cx, cy) from (x0, y0), our current point, to (x1, y1), which
  // spans at most half a turn towards increasing angles (i.e. from the positive X axis towards the positive Y axis, so
  // that an upper arc goes from left to right and a lower arc from right to left), splitting it in two if it spans more
  // than a quarter turn.

  const r = radius;
  const v0x = (x0 - cx) / r;
  const v0y = (y0 - cy) / r;
  const v1x = (x1 - cx) / r;
  const v1y = (y1 - cy) / r;
  const dot = v0x * v1x + v0y * v1y;

  if (dot > 1 - 1e-12) {
    lineTo(path, x1, y1);

    return;
  }

  if (dot < 1e-9) {
    // Our arc spans more than a quarter turn, so split it where it is halfway, i.e. along the bisector of v0 and v1, or
    // along v0 rotated by a positive quarter turn if they are opposite.

    let mx = v0x + v1x;
    let my = v0y + v1y;
    let length = Math.hypot(mx, my);

    if (length < 1e-9) {
      mx = -v0y;
      my = v0x;
      length = 1;
    }

    const middleX = cx + (r * mx) / length;
    const middleY = cy + (r * my) / length;

    arcTo(path, cx, cy, x0, y0, middleX, middleY);
    arcTo(path, cx, cy, middleX, middleY, x1, y1);

    return;
  }

  // The control points of our cubic Bézier curve are along the tangents of our arc at its ends, at 4/3 tan(sweep / 4) r
  // from them, i.e. 4/3 sin(sweep / 2) / (1 + cos(sweep / 2)) r.

  const k = ((4 / 3) * r * Math.sqrt(0.5 * (1 - dot))) / (1 + Math.sqrt(0.5 * (1 + dot)));

  path.bezierCurveTo(x0 - k * v0y, y0 + k * v0x, x1 + k * v1y, y1 - k * v1x, x1, y1);

  currentX = x1;
  currentY = y1;
};

const addEnvelope = (path: StrokeOutlinePath, sign: number): void => {
  // Add our envelope to the given path: our top envelope (with a sign of 1) from left to right, starting a polygon, or
  // our bottom envelope (with a sign of -1, i.e. with negated Y values) from right to left, continuing our polygon.

  let starting = sign > 0;

  for (let i = 0; i < nbOfEntries; ++i) {
    const k = sign > 0 ? i : nbOfEntries - 1 - i;
    const piece = entryPieces[k] as number;
    const start = entryStarts[k] as number;
    const end = k + 1 < nbOfEntries ? (entryStarts[k + 1] as number) : envelopeEnd;

    if (piece === NONE || end - start < MIN_WIDTH) {
      continue;
    }

    const x0 = sign > 0 ? start : end;
    const x1 = sign > 0 ? end : start;
    const y0 = sign * value(piece, x0);
    const y1 = sign * value(piece, x1);

    if (starting) {
      moveTo(path, x0, y0);

      starting = false;
    } else {
      lineTo(path, x0, y0);
    }

    if (pieceKinds[piece] === ARC) {
      arcTo(path, pieceAs[piece] as number, sign * (pieceBs[piece] as number), x0, y0, x1, y1);
    } else {
      lineTo(path, x1, y1);
    }
  }
};

const addRectangle = (path: StrokeOutlinePath, i: number): void => {
  // Add the rectangle of our segment from point i to point i + 1, i.e. our segment offset by r on both sides, with the
  // same orientation as our body (see Note #3 above), i.e. going along its upper side first.

  const x0 = pointXs[i] as number;
  const y0 = pointYs[i] as number;
  const x1 = pointXs[i + 1] as number;
  const y1 = pointYs[i + 1] as number;
  const length = Math.hypot(x1 - x0, y1 - y0);
  const nx = (radius * (y1 - y0)) / length;
  const ny = (-radius * (x1 - x0)) / length;

  moveTo(path, x0 + nx, y0 + ny);
  lineTo(path, x1 + nx, y1 + ny);
  lineTo(path, x1 - nx, y1 - ny);
  lineTo(path, x0 - nx, y0 - ny);

  path.closePath();
};

const addJoin = (path: StrokeOutlinePath, i: number): void => {
  // Add the join of our segments at point i, i.e. the sector of its disk that goes from the outer edge of one of its
  // segments to the outer edge of the other (see Note #2 above), from its centre and towards increasing angles (i.e.
  // with the same orientation as our body), if it has one.

  const cx = pointXs[i] as number;
  const cy = pointYs[i] as number;
  const length0 = Math.hypot(cx - (pointXs[i - 1] as number), cy - (pointYs[i - 1] as number));
  const length1 = Math.hypot((pointXs[i + 1] as number) - cx, (pointYs[i + 1] as number) - cy);
  const ux0 = (cx - (pointXs[i - 1] as number)) / length0;
  const uy0 = (cy - (pointYs[i - 1] as number)) / length0;
  const ux1 = ((pointXs[i + 1] as number) - cx) / length1;
  const uy1 = ((pointYs[i + 1] as number) - cy) / length1;
  const cross = ux0 * uy1 - uy0 * ux1;
  const dot = ux0 * ux1 + uy0 * uy1;
  let fromX: number; // Unit vector from our centre to where our sector starts.
  let fromY: number;
  let toX: number; // Unit vector from our centre to where our sector ends.
  let toY: number;

  if (cross > 0) {
    // u1 is u0 rotated by a positive angle, i.e. our join is on the side of our vectors rotated by a negative quarter
    // turn.

    fromX = uy0;
    fromY = -ux0;
    toX = uy1;
    toY = -ux1;
  } else if (cross < 0) {
    // u1 is u0 rotated by a negative angle, i.e. our join is on the side of our vectors rotated by a positive quarter
    // turn.

    fromX = -uy1;
    fromY = ux1;
    toX = -uy0;
    toY = ux0;
  } else if (dot < 0) {
    // Our polyline goes back on itself, i.e. our join is the half of our disk that is ahead of u0.

    fromX = uy0;
    fromY = -ux0;
    toX = -uy0;
    toY = ux0;
  } else {
    // Our polyline goes straight on, i.e. we don't have a join.

    return;
  }

  moveTo(path, cx, cy);
  lineTo(path, cx + radius * fromX, cy + radius * fromY);
  arcTo(path, cx, cy, cx + radius * fromX, cy + radius * fromY, cx + radius * toX, cy + radius * toY);

  path.closePath();
};

export const addStrokeOutline = (
  path: StrokeOutlinePath,
  xs: Float64Array,
  ys: Float64Array,
  start: number,
  end: number,
  lineWidth: number
): void => {
  // Add, to the given path, the outline of the stroke (with round joins, butt caps, and the given line width) of the
  // given polyline, i.e. of the given points from start to end (included), whose X values must be non-decreasing (see
  // above). The path must be filled using the nonzero rule (i.e. the default one).

  // Our points, without consecutive duplicates.

  if (pointXs.length < end - start + 1) {
    const capacity = Math.max(MIN_INITIAL_CAPACITY, end - start + 1, 2 * pointXs.length);

    pointXs = new Float64Array(capacity);
    pointYs = new Float64Array(capacity);
  }

  nbOfPoints = 0;

  for (let i = start; i <= end; ++i) {
    const x = xs[i] as number;
    const y = ys[i] as number;

    if (nbOfPoints === 0 || x !== pointXs[nbOfPoints - 1] || y !== pointYs[nbOfPoints - 1]) {
      pointXs[nbOfPoints] = x;
      pointYs[nbOfPoints] = y;

      ++nbOfPoints;
    }
  }

  // A polyline with a single (distinct) point doesn't get stroked.

  if (nbOfPoints < 2 || !(lineWidth > 0)) {
    return;
  }

  radius = 0.5 * lineWidth;
  radius2 = radius * radius;

  // Determine our body (see Note #3 above), i.e. our vertices that are at least 2r away from both of our ends in X,
  // from bodyStart to bodyEnd (included), if any.

  const last = nbOfPoints - 1;
  const bodyStartX = (pointXs[0] as number) + 2 * radius;
  const bodyEndX = (pointXs[last] as number) - 2 * radius;
  let bodyStart = 1;

  while (bodyStart < last && (pointXs[bodyStart] as number) < bodyStartX) {
    ++bodyStart;
  }

  let bodyEnd = last - 1;

  while (bodyEnd > 0 && (pointXs[bodyEnd] as number) > bodyEndX) {
    --bodyEnd;
  }

  // Our body, i.e. its top envelope from left to right and then its bottom envelope from right to left.

  const hasBody = bodyStart <= bodyEnd;

  if (hasBody) {
    buildEnvelope(1, bodyStart, bodyEnd);
    addEnvelope(path, 1);
    buildEnvelope(-1, bodyStart, bodyEnd);
    addEnvelope(path, -1);

    path.closePath();
  }

  // The rest of our stroke, i.e. the rectangles of the segments and the joins of the vertices that are not part of our
  // body (i.e. all of them if we don't have a body).

  for (let i = 0; i < last; ++i) {
    if (!hasBody || i < bodyStart || i >= bodyEnd) {
      addRectangle(path, i);
    }

    if (i > 0 && (!hasBody || i < bodyStart || i > bodyEnd)) {
      addJoin(path, i);
    }
  }
};

// Some polylines (e.g., the subpaths of the path of a trace, see linearPaths() in PlotWidget.vue), which can be
// recorded (like a path, i.e. a polyline starts with moveTo() and goes on with lineTo()), so that we can decide whether
// to fill the outline of their stroke (see isDense()) or to stroke them, and then add either to a path.

export interface StrokeOutlinePolylines {
  moveTo: (x: number, y: number) => void; // Start a new polyline at the given point.
  lineTo: (x: number, y: number) => void; // Add the given point to our current polyline (or start one).
  clear: () => void; // Remove all of our polylines.
  nbOfPoints: () => number; // Number of points of our polylines.
  isDense: (lineWidth: number, minTravel: number) => boolean; // See isDense() below.
  addOutline: (path: StrokeOutlinePath, lineWidth: number) => void; // See addOutline() below.
  addPolylines: (path: Pick<StrokeOutlinePath, 'moveTo' | 'lineTo'>) => void; // See addPolylines() below.
}

export const createStrokeOutlinePolylines = (): StrokeOutlinePolylines => {
  let xs = new Float64Array(MIN_INITIAL_CAPACITY);
  let ys = new Float64Array(MIN_INITIAL_CAPACITY);
  let count = 0;
  let starts = new Int32Array(MIN_INITIAL_CAPACITY); // Index of the first point of each of our polylines.
  let nbOfPolylines = 0;

  const addPoint = (x: number, y: number): void => {
    if (count === xs.length) {
      xs = grownFloat64Array(xs, 2 * count);
      ys = grownFloat64Array(ys, 2 * count);
    }

    xs[count] = x;
    ys[count] = y;

    ++count;
  };

  const moveTo = (x: number, y: number): void => {
    if (nbOfPolylines === starts.length) {
      starts = grownInt32Array(starts, 2 * nbOfPolylines);
    }

    starts[nbOfPolylines++] = count;

    addPoint(x, y);
  };

  const lineTo = (x: number, y: number): void => {
    // Like for a path, a lineTo() without a previous moveTo() starts a polyline.

    if (nbOfPolylines === 0) {
      moveTo(x, y);
    } else {
      addPoint(x, y);
    }
  };

  const polylineEnd = (k: number): number => {
    // Return the index after the last point of our kth polyline.

    return k + 1 < nbOfPolylines ? (starts[k + 1] as number) : count;
  };

  const isDense = (lineWidth: number, minTravel: number): boolean => {
    // Return whether we can outline our polylines (i.e. whether their X values are non-decreasing) and whether they are
    // dense, i.e. whether they go up and down by at least minTravel line widths per pixel of width (i.e. per pixel of
    // the sum of their widths, or per pixel if that sum is smaller than one pixel).

    let travel = 0;
    let width = 0;

    for (let k = 0; k < nbOfPolylines; ++k) {
      const start = starts[k] as number;
      const end = polylineEnd(k);

      for (let i = start + 1; i < end; ++i) {
        if ((xs[i] as number) < (xs[i - 1] as number)) {
          return false;
        }

        travel += Math.abs((ys[i] as number) - (ys[i - 1] as number));
      }

      width += (xs[end - 1] as number) - (xs[start] as number);
    }

    return travel >= minTravel * lineWidth * Math.max(1, width);
  };

  const addOutline = (path: StrokeOutlinePath, lineWidth: number): void => {
    // Add, to the given path, the outline of the stroke of our polylines (see addStrokeOutline()), whose X values must
    // be non-decreasing (see isDense()).

    for (let k = 0; k < nbOfPolylines; ++k) {
      addStrokeOutline(path, xs, ys, starts[k] as number, polylineEnd(k) - 1, lineWidth);
    }
  };

  const addPolylines = (path: Pick<StrokeOutlinePath, 'moveTo' | 'lineTo'>): void => {
    // Add our polylines to the given path, so that they can be stroked.

    for (let k = 0; k < nbOfPolylines; ++k) {
      const start = starts[k] as number;
      const end = polylineEnd(k);

      path.moveTo(xs[start] as number, ys[start] as number);

      for (let i = start + 1; i < end; ++i) {
        path.lineTo(xs[i] as number, ys[i] as number);
      }
    }
  };

  return {
    moveTo,
    lineTo,
    clear: () => {
      count = 0;
      nbOfPolylines = 0;
    },
    nbOfPoints: () => count,
    isDense,
    addOutline,
    addPolylines
  };
};

// Our polylines, which are shared (e.g., by all of our plots), since they only ever get used for one path at a time
// (e.g., recorded, checked, and added to a path, see linearPaths() in PlotWidget.vue).

export const strokeOutlinePolylines = createStrokeOutlinePolylines();
