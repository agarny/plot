import { describe, expect, it } from 'bun:test';

import { randomGenerator } from '../../test.utils';
import { type ChunkablePath, createChunkedPath, MAX_PATH_POINTS } from './chunkedPathUtils';

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

const addCommands = (path: ChunkablePath, commands: Command[]): void => {
  for (const [command, x, y] of commands) {
    if (command === 'M') {
      path.moveTo(x, y);
    } else {
      path.lineTo(x, y);
    }
  }
};

const chunkedCommands = (commands: Command[], maxNbOfPoints?: number): Command[][] => {
  // Return the commands of each of the paths into which the given commands get split.

  const path = createChunkedPath(recordedPath, maxNbOfPoints);

  addCommands(path, commands);

  return path.paths.map((recorded) => recorded.commands);
};

const polyline = (from: number, to: number): Command[] => {
  // Return a polyline from the given point to the given point, where point i is (i, 10 * i).

  const res: Command[] = [];

  for (let i = from; i <= to; ++i) {
    res.push([i === from ? 'M' : 'L', i, 10 * i]);
  }

  return res;
};

const joins = (commands: Command[]): Set<string> => {
  // Return the joins of the given commands, i.e. the X values of each three consecutive points of a polyline.

  const res = new Set<string>();

  for (let i = 2; i < commands.length; ++i) {
    const [command1, x1] = commands[i - 1] as Command;
    const [command2, x2] = commands[i] as Command;
    const [, x0] = commands[i - 2] as Command;

    if (command1 === 'L' && command2 === 'L') {
      res.add(`${x0},${x1},${x2}`);
    }
  }

  return res;
};

const randomCommands = (random: () => number, nbOfPoints: number): Command[] => {
  // Return some random commands, i.e. some polylines (including some with only one point), each point of which has a
  // different X value (so that we can tell which point a command is for).

  const res: Command[] = [];

  for (let i = 0; i < nbOfPoints; ++i) {
    res.push([i === 0 || random() < 0.1 ? 'M' : 'L', i, Math.floor(1000 * random())]);
  }

  return res;
};

const unchunkedCommands = (paths: Command[][]): Command[] => {
  // Return the given paths as one path, i.e. without the points that a path carries on from the previous one.
  // Note: this relies on each point having a different X value, so that a point is carried on if it is the last point
  //       that we have (or if it and the next point are our last two points).

  const res: Command[] = [];

  for (const path of paths) {
    let start = 0;
    const last = res.at(-1);
    const beforeLast = res.at(-2);

    if (last && path[0]?.[0] === 'M') {
      if (path[0][1] === last[1]) {
        start = 1;
      } else if (beforeLast && last[0] === 'L' && path[0][1] === beforeLast[1] && path[1]?.[1] === last[1]) {
        expect(path[1][0]).toBe('L');

        start = 2;
      }
    }

    res.push(...path.slice(start));
  }

  return res;
};

// Our tests.

describe('createChunkedPath()', () => {
  it('uses one path if it has at most the maximum number of points', () => {
    const commands = [...polyline(0, 2), ...polyline(3, 4)];

    expect(chunkedCommands(commands, 5)).toEqual([commands]);
    expect(chunkedCommands([], 5)).toEqual([[]]);
  });

  it('carries on from the last segment of the previous path', () => {
    expect(chunkedCommands(polyline(0, 7), 4)).toEqual([polyline(0, 3), polyline(2, 5), polyline(4, 7)]);
  });

  it('carries on from the last point of the previous path if it starts a polyline', () => {
    expect(chunkedCommands([...polyline(0, 1), ...polyline(2, 4)], 3)).toEqual([
      [...polyline(0, 1), ...polyline(2, 2)],
      polyline(2, 4)
    ]);
  });

  it('carries on from nothing if a polyline starts a new path', () => {
    expect(chunkedCommands([...polyline(0, 2), ...polyline(3, 4)], 3)).toEqual([polyline(0, 2), polyline(3, 4)]);
  });

  it('carries on from a polyline that starts with a line, like a canvas would', () => {
    // Note: a canvas treats a line without any current point as a move, so our polyline starts at (0, 0).

    const commands: Command[] = [
      ['L', 0, 0],
      ['L', 1, 10],
      ['L', 2, 20],
      ['L', 3, 30]
    ];

    expect(chunkedCommands(commands, 3)).toEqual([commands.slice(0, 3), polyline(1, 3)]);
    expect(chunkedCommands([['L', 0, 0], ...polyline(1, 3)], 3)).toEqual([
      [['L', 0, 0], ...polyline(1, 2)],
      polyline(1, 3)
    ]);
  });

  it('has at least three points per path', () => {
    const commands = polyline(0, 6);

    expect(chunkedCommands(commands, 1)).toEqual(chunkedCommands(commands, 3));
    expect(chunkedCommands(commands, 3)).toEqual([
      polyline(0, 2),
      polyline(1, 3),
      polyline(2, 4),
      polyline(3, 5),
      polyline(4, 6)
    ]);
  });

  it('uses paths of at most MAX_PATH_POINTS points by default', () => {
    const nbOfPoints = (nbOfLines: number): number[] => {
      const path = createChunkedPath(() => {
        const res = { nbOfPoints: 0, moveTo: () => ++res.nbOfPoints, lineTo: () => ++res.nbOfPoints };

        return res;
      });

      path.moveTo(0, 0);

      for (let i = 0; i < nbOfLines; ++i) {
        path.lineTo(i, i);
      }

      return path.paths.map((counted) => counted.nbOfPoints);
    };

    expect(nbOfPoints(MAX_PATH_POINTS - 1)).toEqual([MAX_PATH_POINTS]);
    expect(nbOfPoints(MAX_PATH_POINTS)).toEqual([MAX_PATH_POINTS, 3]);
  });

  it('draws random polylines as if they were one path', () => {
    const random = randomGenerator(42);

    for (let k = 0; k < 500; ++k) {
      const commands = randomCommands(random, 1 + Math.floor(200 * random()));
      const maxNbOfPoints = 3 + Math.floor(20 * random());
      const paths = chunkedCommands(commands, maxNbOfPoints);
      const expectedJoins = joins(commands);
      const actualJoins = new Set<string>();

      for (const path of paths) {
        expect(path.length).toBeLessThanOrEqual(maxNbOfPoints);

        for (const join of joins(path)) {
          actualJoins.add(join);
        }
      }

      // Our paths have the same commands, once the points that they carry on from are removed, and the same joins (so
      // our polylines look the same when stroked).

      expect(unchunkedCommands(paths)).toEqual(commands);
      expect(actualJoins).toEqual(expectedJoins);
    }
  });
});
