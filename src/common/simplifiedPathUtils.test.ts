import { describe, expect, it } from 'bun:test';

import { randomGenerator } from '../../test.utils';

import type { ChunkablePath } from './chunkedPathUtils';
import { SimplifiedPath, SMOOTHNESS_CHECK_INTERVAL, TraceSmoothness } from './simplifiedPathUtils';

// Some helpers.

type Command = ['M' | 'L', number, number];

interface RecordedPath extends ChunkablePath {
  commands: Command[];
}

const recordedPath = (): RecordedPath => {
  // Return a path that records what gets added to it.

  const commands: Command[] = [];

  return {
    commands,
    moveTo: (x: number, y: number) => {
      commands.push(['M', x, y]);
    },
    lineTo: (x: number, y: number) => {
      commands.push(['L', x, y]);
    }
  };
};

const simplifiedCommands = (commands: Command[], tolerance: number, maxNbOfPoints?: number): Command[] => {
  // Return the commands that the given commands get simplified to using the given tolerance (and maximum number of
  // points, if any), checking that the simplified path knows how many points it added.

  const recorded = recordedPath();
  const path = new SimplifiedPath(recorded, tolerance, maxNbOfPoints);

  for (const [command, x, y] of commands) {
    if (command === 'M') {
      path.moveTo(x, y);
    } else {
      path.lineTo(x, y);
    }
  }

  path.end();

  expect(path.nbOfPoints).toBe(recorded.commands.length);

  return recorded.commands;
};

const polylines = (commands: Command[]): Command[][] => {
  // Return the polylines of the given commands, i.e. the commands that start with each moveTo().

  const res: Command[][] = [];

  for (const command of commands) {
    if (command[0] === 'M' || !res.length) {
      res.push([]);
    }

    res[res.length - 1]?.push(command);
  }

  return res;
};

const distanceToSegment = (x: number, y: number, x0: number, y0: number, x1: number, y1: number): number => {
  // Return the distance between the given point and the given segment.

  const dx = x1 - x0;
  const dy = y1 - y0;
  const squaredLength = dx * dx + dy * dy;
  const t = squaredLength ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / squaredLength)) : 0;

  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
};

const expectWithinTolerance = (commands: Command[], simplified: Command[], tolerance: number): void => {
  // Check that the given simplified commands have the same polylines as the given commands, that each of their
  // polylines has the same first and last points, that its points are some of the original points, in the same order,
  // and that each original point is within the given tolerance of the segment that replaced it.

  const originalPolylines = polylines(commands);
  const simplifiedPolylines = polylines(simplified);

  expect(simplifiedPolylines.length).toBe(originalPolylines.length);

  for (let i = 0; i < originalPolylines.length; ++i) {
    const original = originalPolylines[i] as Command[];
    const kept = simplifiedPolylines[i] as Command[];
    let k = 0;

    expect(kept[0]).toEqual(['M', (original[0] as Command)[1], (original[0] as Command)[2]]);
    expect(kept[kept.length - 1]?.slice(1)).toEqual((original[original.length - 1] as Command).slice(1));
    expect(kept.length).toBeLessThanOrEqual(original.length);

    for (let j = 1; j < original.length; ++j) {
      const [, x, y] = original[j] as Command;
      const [, x0, y0] = kept[k] as Command;
      const next = kept[k + 1] as Command;

      if (next[1] === x && next[2] === y) {
        ++k;

        continue;
      }

      expect(distanceToSegment(x, y, x0, y0, next[1], next[2])).toBeLessThanOrEqual(tolerance * (1 + 1e-9));
    }

    expect(k).toBe(kept.length - 1);
  }
};

const circle = (nbOfPoints: number, radius: number): Command[] => {
  // Return a circle of the given radius as a polyline of the given number of points.

  const res: Command[] = [];

  for (let i = 0; i < nbOfPoints; ++i) {
    const angle = (2 * Math.PI * i) / (nbOfPoints - 1);

    res.push([i ? 'L' : 'M', radius * Math.cos(angle), radius * Math.sin(angle)]);
  }

  return res;
};

// Our tests.

describe('SimplifiedPath', () => {
  it('keeps the first and last points of a polyline', () => {
    expect(simplifiedCommands([['M', 1, 2]], 0.25)).toEqual([['M', 1, 2]]);
    expect(
      simplifiedCommands(
        [
          ['M', 1, 2],
          ['L', 3, 4]
        ],
        0.25
      )
    ).toEqual([
      ['M', 1, 2],
      ['L', 3, 4]
    ]);
  });

  it('replaces points that are nearly on a line with a segment', () => {
    const commands: Command[] = [];

    // Points that are within 0.1 of the X axis, i.e. within 0.2 of a segment from any of them to any other of them.

    for (let i = 0; i <= 1000; ++i) {
      commands.push([i ? 'L' : 'M', i, 0.1 * Math.sin(i)]);
    }

    expect(simplifiedCommands(commands, 0.25)).toEqual([
      ['M', 0, 0],
      ['L', 1000, 0.1 * Math.sin(1000)]
    ]);
  });

  it('replaces points that are within its tolerance of the start of a segment', () => {
    expect(
      simplifiedCommands(
        [
          ['M', 0, 0],
          ['L', 0.1, 0.1],
          ['L', -0.1, 0.1],
          ['L', 0.1, -0.1]
        ],
        0.25
      )
    ).toEqual([
      ['M', 0, 0],
      ['L', 0.1, -0.1]
    ]);
  });

  it('ends a segment at a point that is further than its tolerance and that a point within it comes back from', () => {
    expect(
      simplifiedCommands(
        [
          ['M', 0, 0],
          ['L', 10, 0],
          ['L', 0.1, 0]
        ],
        0.25
      )
    ).toEqual([
      ['M', 0, 0],
      ['L', 10, 0],
      ['L', 0.1, 0]
    ]);
  });

  it('ends a segment at a point that a further point is not beyond', () => {
    expect(
      simplifiedCommands(
        [
          ['M', 0, 0],
          ['L', 10, 0],
          ['L', 5, 0]
        ],
        0.25
      )
    ).toEqual([
      ['M', 0, 0],
      ['L', 10, 0],
      ['L', 5, 0]
    ]);
  });

  it('keeps the corners and peaks of a polyline', () => {
    const zigzag: Command[] = [];

    for (let i = 0; i <= 100; ++i) {
      zigzag.push([i ? 'L' : 'M', i, i % 2 ? 1 : -1]);
    }

    expect(simplifiedCommands(zigzag, 0.25)).toEqual(zigzag);
  });

  it('simplifies a smooth curve to a few segments within its tolerance', () => {
    const commands = circle(100000, 1000);
    const simplified = simplifiedCommands(commands, 0.25);

    // A chord of a circle of radius r that is within t of its arc spans an angle of 2 * acos(1 - t / r), i.e. we need
    // at least about 99 segments here.

    expect(simplified.length).toBeGreaterThan(99);
    expect(simplified.length).toBeLessThan(250);

    expectWithinTolerance(commands, simplified, 0.25);
  });

  it('simplifies each polyline on its own', () => {
    const commands = [...circle(1000, 100), ...circle(1000, 200), ['M', 5, 5] as Command, ...circle(1000, 300)];
    const simplified = simplifiedCommands(commands, 0.5);

    expect(polylines(simplified).length).toBe(4);

    expectWithinTolerance(commands, simplified, 0.5);
  });

  it('starts a polyline from a point that is not preceded by a moveTo()', () => {
    expect(
      simplifiedCommands(
        [
          ['L', 1, 2],
          ['L', 3, 4],
          ['L', 5, 6]
        ],
        0.25
      )
    ).toEqual([
      ['M', 1, 2],
      ['L', 5, 6]
    ]);
  });

  it('adds its polylines as they are if its tolerance is zero', () => {
    const commands: Command[] = [['L', 7, 8], ...circle(1000, 100), ['M', 5, 5], ['L', 5, 5], ['M', 1, 2], ['L', 3, 4]];

    expect(simplifiedCommands(commands, 0)).toEqual([['M', 7, 8], ...commands.slice(1)]);
  });

  it('stops simplifying as soon as it has added more than its maximum number of points', () => {
    // A zig-zag, i.e. points that are all kept, followed by points on a line, i.e. points that would otherwise be
    // replaced with a segment, and by another polyline on a line.

    const zigZag: Command[] = Array.from({ length: 10 }, (_value, i) => [i ? 'L' : 'M', i, 10 * (i % 2)]);
    const line: Command[] = Array.from({ length: 10 }, (_value, i) => ['L', 10 + i, 10 + i]);
    const otherLine: Command[] = Array.from({ length: 10 }, (_value, i) => [i ? 'L' : 'M', i, 20 + i]);
    const commands = [...zigZag, ...line, ...otherLine];

    expect(simplifiedCommands(commands, 0.25)).toEqual([
      ...zigZag,
      ['L', 10, 10],
      ['L', 19, 19],
      ['M', 0, 20],
      ['L', 9, 29]
    ]);

    // With a maximum of five points, our sixth point is added once our seventh point gets processed, at which point we
    // stop simplifying, i.e. our seventh point and all of the points after it are added as they are.

    expect(simplifiedCommands(commands, 0.25, 5)).toEqual(commands);

    // With a maximum that we don't exceed, we simplify as usual.

    expect(simplifiedCommands(commands, 0.25, 14)).toEqual(simplifiedCommands(commands, 0.25));
  });

  it('knows whether it reduced the points that it was given to a given fraction of them', () => {
    const reducedTo = (commands: Command[], tolerance: number, maxNbOfPoints?: number): [number, boolean] => {
      const path = new SimplifiedPath(recordedPath(), tolerance, maxNbOfPoints);

      for (const [command, x, y] of commands) {
        if (command === 'M') {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }

      path.end();

      return [path.nbOfGivenPoints, path.reducedTo(0.25)];
    };

    // A smooth curve gets reduced to a few of its points, unlike a zig-zag (all of whose points are kept), whether or
    // not it is followed by a smooth curve that we would have reduced, had we not stopped simplifying beforehand.

    const zigZag: Command[] = Array.from({ length: 100 }, (_value, i) => [i ? 'L' : 'M', i, 10 * (i % 2)]);

    expect(reducedTo(circle(1000, 100), 0.25)).toEqual([1000, true]);
    expect(reducedTo(zigZag, 0.25)).toEqual([100, false]);
    expect(reducedTo([...zigZag, ...circle(1000, 100)], 0.25, 25)[1]).toBe(false);

    // Nothing gets reduced if we don't simplify (and we are then given no points while simplifying).

    expect(reducedTo(circle(1000, 100), 0)).toEqual([0, false]);
  });

  it('adds nothing more when it gets ended again', () => {
    const recorded = recordedPath();
    const path = new SimplifiedPath(recorded, 0.25);

    path.moveTo(0, 0);
    path.lineTo(1, 1);
    path.end();
    path.end();

    expect(recorded.commands).toEqual([
      ['M', 0, 0],
      ['L', 1, 1]
    ]);
  });

  it('keeps random polylines within its tolerance', () => {
    const random = randomGenerator(42);

    for (let test = 0; test < 200; ++test) {
      const tolerance = 0.05 + 2 * random();
      const step = 10 * random() ** 2;
      const commands: Command[] = [];
      let x = 0;
      let y = 0;
      let angle = 0;

      for (let i = 0; i < 500; ++i) {
        // A random walk that turns more or less smoothly (i.e. from smooth curves to noise), with a few new polylines.

        if (random() < 0.01) {
          commands.push(['M', x, y]);
        } else {
          angle += (random() - 0.5) * (test % 4) ** 2;
          x += step * Math.cos(angle);
          y += step * Math.sin(angle);

          commands.push([i ? 'L' : 'M', x, y]);
        }
      }

      expectWithinTolerance(commands, simplifiedCommands(commands, tolerance), tolerance);
    }
  });
});

// TraceSmoothness.

describe('TraceSmoothness', () => {
  const SMOOTH_TRACE_RATIO = 0.25;
  const zigZag: Command[] = Array.from({ length: 100 }, (_value, i) => [i ? 'L' : 'M', i, 10 * (i % 2)]);

  const simplifiedPath = (commands: Command[], tolerance: number = 0.25): SimplifiedPath => {
    // Return a simplified path (with the given tolerance) to which the given commands have been added.

    const res = new SimplifiedPath(recordedPath(), tolerance, SMOOTH_TRACE_RATIO * commands.length);

    for (const [command, x, y] of commands) {
      if (command === 'M') {
        res.moveTo(x, y);
      } else {
        res.lineTo(x, y);
      }
    }

    res.end();

    return res;
  };

  const simplifications = (smoothness: TraceSmoothness, nbOfPaths: number): boolean[] => {
    // Return whether each of the given number of paths that are about to be built for our trace should be simplified.

    return Array.from({ length: nbOfPaths }, () => smoothness.simplifiesNextPath());
  };

  it('simplifies the paths of a trace until it knows whether it is smooth', () => {
    const smoothness = new TraceSmoothness();

    expect(smoothness.isSmooth()).toBe(false);
    expect(simplifications(smoothness, 3 * SMOOTHNESS_CHECK_INTERVAL)).not.toContain(false);
  });

  it('simplifies all the paths of a smooth trace', () => {
    const smoothness = new TraceSmoothness();

    smoothness.update(simplifiedPath(circle(1000, 100)), SMOOTH_TRACE_RATIO);

    expect(smoothness.isSmooth()).toBe(true);
    expect(simplifications(smoothness, 3 * SMOOTHNESS_CHECK_INTERVAL)).not.toContain(false);
  });

  it('only simplifies one path of a trace that is not smooth every SMOOTHNESS_CHECK_INTERVAL paths', () => {
    const smoothness = new TraceSmoothness();

    smoothness.update(simplifiedPath(zigZag), SMOOTH_TRACE_RATIO);

    expect(smoothness.isSmooth()).toBe(false);

    for (let i = 0; i < 3; ++i) {
      const expected = Array.from(
        { length: SMOOTHNESS_CHECK_INTERVAL },
        (_value, j) => j === SMOOTHNESS_CHECK_INTERVAL - 1
      );

      expect(simplifications(smoothness, SMOOTHNESS_CHECK_INTERVAL)).toEqual(expected);
    }
  });

  it('finds out when a trace that was not smooth becomes smooth, and vice versa', () => {
    const smoothness = new TraceSmoothness();

    smoothness.update(simplifiedPath(zigZag), SMOOTH_TRACE_RATIO);

    expect(simplifications(smoothness, SMOOTHNESS_CHECK_INTERVAL).at(-1)).toBe(true);

    smoothness.update(simplifiedPath(circle(1000, 100)), SMOOTH_TRACE_RATIO);

    expect(smoothness.isSmooth()).toBe(true);
    expect(simplifications(smoothness, SMOOTHNESS_CHECK_INTERVAL)).not.toContain(false);

    smoothness.update(simplifiedPath(zigZag), SMOOTH_TRACE_RATIO);

    expect(smoothness.isSmooth()).toBe(false);
    expect(simplifications(smoothness, SMOOTHNESS_CHECK_INTERVAL)).toContain(false);
  });

  it('keeps its smoothness if a path was given no points to simplify', () => {
    // Note: a path that doesn't simplify our trace (i.e. with a tolerance of zero) or that is given no points (e.g., if
    //       our trace cannot be seen) can't tell whether our trace is smooth.

    const smoothness = new TraceSmoothness();

    smoothness.update(simplifiedPath(circle(1000, 100)), SMOOTH_TRACE_RATIO);
    smoothness.update(simplifiedPath(zigZag, 0), SMOOTH_TRACE_RATIO);
    smoothness.update(simplifiedPath([]), SMOOTH_TRACE_RATIO);

    expect(smoothness.isSmooth()).toBe(true);

    smoothness.update(simplifiedPath(zigZag), SMOOTH_TRACE_RATIO);
    smoothness.update(simplifiedPath(circle(1000, 100), 0), SMOOTH_TRACE_RATIO);
    smoothness.update(simplifiedPath([]), SMOOTH_TRACE_RATIO);

    expect(smoothness.isSmooth()).toBe(false);
  });
});
