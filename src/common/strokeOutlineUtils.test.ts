import { describe, expect, it } from 'bun:test';

import { randomGenerator } from '../../test.utils';
import {
  addStrokeOutline,
  createStrokeOutlinePolylines,
  type StrokeOutlinePath,
  strokeOutlinePolylines
} from './strokeOutlineUtils';

// Some helpers.

const NB_OF_BEZIER_SEGMENTS = 64; // Number of segments into which we flatten a cubic Bézier curve.

interface RecordedPath extends StrokeOutlinePath {
  polygons: number[][]; // Our closed polygons, i.e. x0, y0, x1, y1, etc.
  nbOfCommands: number;
  nbOfMoves: number;
  nbOfCurves: number;
  closed: boolean;
}

const recordedPath = (): RecordedPath => {
  // Return a path that records what gets added to it, flattening cubic Bézier curves.

  let current: number[] = [];

  const res: RecordedPath = {
    polygons: [],
    nbOfCommands: 0,
    nbOfMoves: 0,
    nbOfCurves: 0,
    closed: false,
    moveTo: (x: number, y: number) => {
      ++res.nbOfCommands;
      ++res.nbOfMoves;

      current = [x, y];
    },
    lineTo: (x: number, y: number) => {
      ++res.nbOfCommands;

      current.push(x, y);
    },
    bezierCurveTo: (cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) => {
      ++res.nbOfCommands;
      ++res.nbOfCurves;

      const x0 = current[current.length - 2] as number;
      const y0 = current[current.length - 1] as number;

      for (let i = 1; i <= NB_OF_BEZIER_SEGMENTS; ++i) {
        const t = i / NB_OF_BEZIER_SEGMENTS;
        const u = 1 - t;

        current.push(
          u * u * u * x0 + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * y
        );
      }
    },
    closePath: () => {
      ++res.nbOfCommands;

      res.polygons.push(current);
      res.closed = true;

      current = [];
    }
  };

  return res;
};

const windingNumber = (polygons: number[][], x: number, y: number): number => {
  // Return the winding number of the given point with respect to the given polygons.

  let res = 0;

  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i += 2) {
      const x0 = polygon[i] as number;
      const y0 = polygon[i + 1] as number;
      const x1 = polygon[(i + 2) % polygon.length] as number;
      const y1 = polygon[(i + 3) % polygon.length] as number;
      const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);

      if (y0 <= y) {
        if (y1 > y && side > 0) {
          ++res;
        }
      } else if (y1 <= y && side < 0) {
        --res;
      }
    }
  }

  return res;
};

const isInStroke = (xs: number[], ys: number[], r: number, x: number, y: number): boolean => {
  // Return whether the given point is in the stroke of the given polyline, with round joins and butt caps, as defined
  // by the HTML specification: the union of a rectangle around each segment and of a join at each interior vertex, i.e.
  // the sector of its disk that goes from the outer edge of one of its segments to the outer edge of the other.
  // Note: we ignore zero-length segments, like a browser does.

  const pxs: number[] = [];
  const pys: number[] = [];

  for (let i = 0; i < xs.length; ++i) {
    if (i === 0 || xs[i] !== pxs[pxs.length - 1] || ys[i] !== pys[pys.length - 1]) {
      pxs.push(xs[i] as number);
      pys.push(ys[i] as number);
    }
  }

  // Our rectangles.

  for (let i = 0; i + 1 < pxs.length; ++i) {
    const dx = (pxs[i + 1] as number) - (pxs[i] as number);
    const dy = (pys[i + 1] as number) - (pys[i] as number);
    const length = Math.hypot(dx, dy);
    const along = ((x - (pxs[i] as number)) * dx + (y - (pys[i] as number)) * dy) / length;
    const across = ((x - (pxs[i] as number)) * dy - (y - (pys[i] as number)) * dx) / length;

    if (along >= 0 && along <= length && Math.abs(across) <= r) {
      return true;
    }
  }

  // Our joins.

  for (let i = 1; i + 1 < pxs.length; ++i) {
    const wx = x - (pxs[i] as number);
    const wy = y - (pys[i] as number);

    if (wx * wx + wy * wy > r * r) {
      continue;
    }

    const length0 = Math.hypot(
      (pxs[i] as number) - (pxs[i - 1] as number),
      (pys[i] as number) - (pys[i - 1] as number)
    );
    const length1 = Math.hypot(
      (pxs[i + 1] as number) - (pxs[i] as number),
      (pys[i + 1] as number) - (pys[i] as number)
    );
    const ux0 = ((pxs[i] as number) - (pxs[i - 1] as number)) / length0;
    const uy0 = ((pys[i] as number) - (pys[i - 1] as number)) / length0;
    const ux1 = ((pxs[i + 1] as number) - (pxs[i] as number)) / length1;
    const uy1 = ((pys[i + 1] as number) - (pys[i] as number)) / length1;
    const cross = ux0 * uy1 - uy0 * ux1;
    const dot = ux0 * ux1 + uy0 * uy1;
    const crossProduct = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

    if (cross > 0) {
      // The join is between u0 and u1 rotated by a negative quarter turn, i.e. (uy, -ux).

      if (crossProduct(uy0, -ux0, wx, wy) >= 0 && crossProduct(wx, wy, uy1, -ux1) >= 0) {
        return true;
      }
    } else if (cross < 0) {
      // The join is between u1 and u0 rotated by a positive quarter turn, i.e. (-uy, ux).

      if (crossProduct(-uy1, ux1, wx, wy) >= 0 && crossProduct(wx, wy, -uy0, ux0) >= 0) {
        return true;
      }
    } else if (dot < 0 && wx * ux0 + wy * uy0 >= 0) {
      // A U-turn, i.e. the join is the half of the disk that is ahead of u0.

      return true;
    }
  }

  return false;
};

const MARGIN = 0.01; // Distance (in pixels) from the boundary of a stroke within which we don't check a point.

const checkOutline = (
  xs: number[],
  ys: number[],
  lineWidth: number,
  nbOfChecks: number,
  seed: number,
  box?: [xMin: number, xMax: number, yMin: number, yMax: number]
): number => {
  // Check that the outline of the stroke of the given polyline covers exactly the stroke of that polyline, at random
  // points (within the given box or around our polyline) that are not within MARGIN of the boundary of that stroke, and
  // return the number of points that we checked.

  const path = recordedPath();
  const r = 0.5 * lineWidth;

  addStrokeOutline(path, Float64Array.from(xs), Float64Array.from(ys), 0, xs.length - 1, lineWidth);

  const random = randomGenerator(seed);
  const [xMin, xMax, yMin, yMax] = box ?? [
    Math.min(...xs) - r - 1,
    Math.max(...xs) + r + 1,
    Math.min(...ys) - r - 1,
    Math.max(...ys) + r + 1
  ];
  let res = 0;

  for (let i = 0; i < nbOfChecks; ++i) {
    const x = xMin + random() * (xMax - xMin);
    const y = yMin + random() * (yMax - yMin);
    const expected = isInStroke(xs, ys, r, x, y);

    // Skip a point that is close to the boundary of our stroke, i.e. if one of its neighbours is not like it.

    let ambiguous = false;

    for (let k = 0; k < 8 && !ambiguous; ++k) {
      const angle = (k * Math.PI) / 4;

      ambiguous = isInStroke(xs, ys, r, x + MARGIN * Math.cos(angle), y + MARGIN * Math.sin(angle)) !== expected;
    }

    if (ambiguous) {
      continue;
    }

    ++res;

    if ((windingNumber(path.polygons, x, y) !== 0) !== expected) {
      throw new Error(
        `The outline is wrong at (${x}, ${y}), which is ${expected ? '' : 'not '}in the stroke of ${JSON.stringify(xs.map((value, index) => [value, ys[index]]))} (line width: ${lineWidth}).`
      );
    }
  }

  return res;
};

// Some x-monotone polylines.

type Kind = 'dense' | 'sparse' | 'steps' | 'vertical' | 'duplicates' | 'short' | 'smooth';

const polyline = (kind: Kind, nbOfPoints: number, random: () => number): [number[], number[]] => {
  const xs: number[] = [];
  const ys: number[] = [];
  let x = 10 * random();

  for (let i = 0; i < nbOfPoints; ++i) {
    switch (kind) {
      case 'dense':
        // Like the vertical zig-zags that our level of detail keeps in each pixel column of noisy data.

        x += 0.3 * random();
        ys.push(50 * random());

        break;
      case 'sparse':
        x += 8 * random();
        ys.push(50 * random());

        break;
      case 'steps':
        if (i % 2) {
          x += 6 * random();
          ys.push(ys[i - 1] as number);
        } else {
          ys.push(10 * Math.floor(4 * random()));
        }

        break;
      case 'vertical':
        // Vertical segments, and so U-turns, i.e. a segment that goes up followed by one that goes down at the same X.

        if (random() < 0.4) {
          x += 3 * random();
        }

        ys.push(30 * random());

        break;
      case 'duplicates':
        if (random() < 0.5) {
          x += 2 * random();
        }

        ys.push(i > 0 && random() < 0.4 ? (ys[i - 1] as number) : 20 * random());

        break;
      case 'short':
        // Short segments, so that the joins near the ends of our polyline matter (see Note #3 of
        // strokeOutlineUtils.ts).

        x += 0.5 * random();
        ys.push(3 * random());

        break;
      default:
        x += 0.5 + random();
        ys.push(20 * Math.sin(0.2 * i));
    }

    xs.push(x);
  }

  return [xs, ys];
};

// Our tests.

describe('addStrokeOutline()', () => {
  it('covers exactly the stroke of a polyline', () => {
    const kinds: Kind[] = ['dense', 'sparse', 'steps', 'vertical', 'duplicates', 'short', 'smooth'];
    const random = randomGenerator(1);
    let nbOfChecks = 0;

    for (let trial = 0; trial < 700; ++trial) {
      const kind = kinds[trial % kinds.length] as Kind;
      const [xs, ys] = polyline(kind, 2 + Math.floor(random() * 30), random);
      const lineWidth = trial % 3 === 0 ? 4 : 1 + 5 * random();

      nbOfChecks += checkOutline(xs, ys, lineWidth, 150, trial);
    }

    expect(nbOfChecks).toBeGreaterThan(80000);
  });

  it('covers exactly the stroke of a long dense polyline', () => {
    // Enough points for our arrays to have to grow.

    const random = randomGenerator(2);
    const [xs, ys] = polyline('dense', 3000, random);

    expect(checkOutline(xs, ys, 4, 3000, 3)).toBeGreaterThan(2000);
  });

  it('covers exactly the stroke of steep segments far from the origin', () => {
    // A steep segment (e.g., when zoomed in vertically on noisy data) that crosses the disk of a vertex far from the
    // origin, where computing their crossing in absolute coordinates would lose most of its precision (and miss it,
    // leaving a hole in our outline).

    const xs = [2000, 2002, 2002.5, 2003, 2012];
    const ys = [10623, -13097, 14552, 495, 16298];

    expect(checkOutline(xs, ys, 2, 3000, 4, [2002.9, 2003.4, -500, 500])).toBeGreaterThan(2000);
  });

  it('handles U-turns, straight joins, and joins near both ends', () => {
    // Up and down at the same X value (U-turns), collinear points (straight joins), and short segments at both ends.

    const cases: [number[], number[]][] = [
      [
        [0, 0, 0, 0, 5],
        [0, 10, 2, 12, 12]
      ],
      [
        [0, 1, 2, 3, 4],
        [0, 1, 2, 3, 4]
      ],
      [
        [0, 0.3, 0.6, 10, 10.2, 10.5],
        [0, 1, 0, 0, 1.5, 0]
      ],
      [
        [0, 0.1, 0.1, 20],
        [5, 0, 10, 5]
      ]
    ];

    for (const [index, [xs, ys]] of cases.entries()) {
      for (const lineWidth of [1, 4, 9]) {
        expect(checkOutline(xs, ys, lineWidth, 3000, index)).toBeGreaterThan(500);
      }
    }
  });

  it('handles points whose X values are almost the same', () => {
    // Segments that are almost vertical, i.e. whose arcs and edges are (almost) empty in our envelope.

    const xs = [0, 5, 10, 10 + 1e-12, 10 + 2e-12, 15, 20];
    const ys = [0, 3, 0, 4, -2, 1, 0];

    for (const lineWidth of [1, 4]) {
      expect(checkOutline(xs, ys, lineWidth, 3000, 6)).toBeGreaterThan(2000);
    }
  });

  it('handles a tiny zig-zag that moves away from a point', () => {
    // The rectangles of the segments of a tiny zig-zag fan out away from it, leaving gaps between them on its left
    // (around (0, 0)), even though its vertices are far from its first point along it (see Note #2 of
    // strokeOutlineUtils.ts).

    const xs = [5];
    const ys = [0];

    for (let i = 1; i <= 200; ++i) {
      xs.push(5 + 0.2 * i);
      ys.push(i % 2 ? 0.5 : -0.5);
    }

    const path = recordedPath();

    addStrokeOutline(path, Float64Array.from(xs), Float64Array.from(ys), 0, xs.length - 1, 20);

    expect(windingNumber(path.polygons, 0, 0)).toBe(0);
    expect(checkOutline(xs, ys, 20, 20000, 5, [-6, 15, -3, 3])).toBeGreaterThan(15000);
  });

  it('adds a polygon for the body of a polyline and one for each segment and join near its ends', () => {
    // A body (vertices 1 to 3) and the rectangles of the first and last segments, and then no body, i.e. the rectangles
    // of both segments and the join between them.

    const cases: [number[], number[], number][] = [
      [[0, 10, 20, 30, 40], [0, 10, 0, 10, 0], 3],
      [[0, 1, 2], [0, 5, 0], 3]
    ];

    for (const [xs, ys, nbOfPolygons] of cases) {
      const path = recordedPath();

      addStrokeOutline(path, Float64Array.from(xs), Float64Array.from(ys), 0, xs.length - 1, 4);

      expect(path.nbOfMoves).toBe(nbOfPolygons);
      expect(path.polygons.length).toBe(nbOfPolygons);
      expect(path.closed).toBe(true);
      expect(path.nbOfCurves).toBeGreaterThan(0);
    }
  });

  it('only uses the given points', () => {
    // The points before start and after end must be ignored.

    const xs = Float64Array.from([-100, 0, 5, 10, 100]);
    const ys = Float64Array.from([-100, 0, 10, 0, -100]);
    const path = recordedPath();
    const reference = recordedPath();

    addStrokeOutline(path, xs, ys, 1, 3, 4);
    addStrokeOutline(reference, xs.subarray(1, 4), ys.subarray(1, 4), 0, 2, 4);

    expect(path.polygons).toEqual(reference.polygons);
  });

  it('adds nothing for a polyline that does not get stroked', () => {
    // A single point, identical points, an empty range, and a null (or invalid) line width.

    const cases: [Float64Array, Float64Array, number, number, number][] = [
      [Float64Array.from([1]), Float64Array.from([2]), 0, 0, 4],
      [Float64Array.from([1, 1, 1]), Float64Array.from([2, 2, 2]), 0, 2, 4],
      [Float64Array.from([1, 2]), Float64Array.from([2, 3]), 1, 0, 4],
      [Float64Array.from([1, 2]), Float64Array.from([2, 3]), 0, 1, 0],
      [Float64Array.from([1, 2]), Float64Array.from([2, 3]), 0, 1, Number.NaN]
    ];

    for (const [xs, ys, start, end, lineWidth] of cases) {
      const path = recordedPath();

      addStrokeOutline(path, xs, ys, start, end, lineWidth);

      expect(path.nbOfCommands).toBe(0);
    }
  });
});

describe('createStrokeOutlinePolylines()', () => {
  it('records polylines and adds them to a path', () => {
    // A lineTo() without a previous moveTo() starts a polyline, like for a path, and enough polylines and points for
    // our arrays to have to grow.

    const polylines = createStrokeOutlinePolylines();
    const expectedCommands: string[] = [];

    polylines.lineTo(0, 1);

    expectedCommands.push('M0,1');

    for (let k = 0; k < 300; ++k) {
      polylines.moveTo(k, -k);

      expectedCommands.push(`M${k},${-k}`);

      for (let i = 1; i <= 3; ++i) {
        polylines.lineTo(k + 0.1 * i, i);

        expectedCommands.push(`L${k + 0.1 * i},${i}`);
      }
    }

    const commands: string[] = [];

    polylines.addPolylines({
      moveTo: (x: number, y: number) => commands.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => commands.push(`L${x},${y}`)
    });

    expect(polylines.nbOfPoints()).toBe(1201);
    expect(commands).toEqual(expectedCommands);

    // Clearing our polylines removes all of them.

    polylines.clear();

    commands.length = 0;

    polylines.addPolylines({
      moveTo: (x: number, y: number) => commands.push(`M${x},${y}`),
      lineTo: (x: number, y: number) => commands.push(`L${x},${y}`)
    });

    expect(polylines.nbOfPoints()).toBe(0);
    expect(commands).toEqual([]);
  });

  it('adds the outline of each of its polylines', () => {
    const random = randomGenerator(7);
    const polylines = createStrokeOutlinePolylines();
    const path = recordedPath();
    const reference = recordedPath();

    for (let k = 0; k < 3; ++k) {
      const [xs, ys] = polyline('dense', 50, random);

      polylines.moveTo(xs[0] as number, ys[0] as number);

      for (let i = 1; i < xs.length; ++i) {
        polylines.lineTo(xs[i] as number, ys[i] as number);
      }

      addStrokeOutline(reference, Float64Array.from(xs), Float64Array.from(ys), 0, xs.length - 1, 4);
    }

    polylines.addOutline(path, 4);

    expect(path.polygons.length).toBeGreaterThan(3);
    expect(path.polygons).toEqual(reference.polygons);
  });

  it('tells whether its polylines can be outlined and are dense', () => {
    const polylines = createStrokeOutlinePolylines();
    const record = (points: [number, number][][]): void => {
      polylines.clear();

      for (const polylinePoints of points) {
        for (const [index, [x, y]] of polylinePoints.entries()) {
          if (index === 0) {
            polylines.moveTo(x, y);
          } else {
            polylines.lineTo(x, y);
          }
        }
      }
    };

    // A zig-zag that goes up and down by 100 pixels per pixel, i.e. by 25 line widths of 4 pixels.

    record([
      [
        [0, 0],
        [1, 100],
        [2, 0]
      ]
    ]);

    expect(polylines.isDense(4, 25)).toBe(true);
    expect(polylines.isDense(4, 26)).toBe(false);

    // A zig-zag split in two polylines, the second of which is vertical, i.e. one pixel wide in total (the sum of the
    // widths of its polylines), so that it goes up and down by 200 pixels per pixel (i.e. by 50 line widths of 4
    // pixels), and then the same, but with a second polyline that goes back in X, i.e. which cannot be outlined.

    record([
      [
        [0, 0],
        [1, 100]
      ],
      [
        [1, 100],
        [1, 0]
      ]
    ]);

    expect(polylines.isDense(4, 50)).toBe(true);
    expect(polylines.isDense(4, 51)).toBe(false);

    record([
      [
        [0, 0],
        [1, 100]
      ],
      [
        [2, 100],
        [1.5, 0]
      ]
    ]);

    expect(polylines.isDense(4, 1)).toBe(false);

    // A vertical polyline, i.e. with no width, which is dense per pixel.

    record([
      [
        [5, 0],
        [5, 40]
      ]
    ]);

    expect(polylines.isDense(4, 10)).toBe(true);
    expect(polylines.isDense(4, 11)).toBe(false);

    // A smooth line.

    record([
      [
        [0, 0],
        [100, 50]
      ]
    ]);

    expect(polylines.isDense(4, 1)).toBe(false);
  });

  it('has a shared instance', () => {
    strokeOutlinePolylines.clear();
    strokeOutlinePolylines.moveTo(0, 0);
    strokeOutlinePolylines.lineTo(1, 1);

    expect(strokeOutlinePolylines.nbOfPoints()).toBe(2);

    strokeOutlinePolylines.clear();
  });
});
