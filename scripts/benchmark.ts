#!/usr/bin/env bun

// Benchmark our plot in Chrome, Firefox, and/or Safari, for different scenarios, using the benchmark of our demo (see
// runBenchmark() and demoBenchmark in demo/App.vue), and save its results as a report (in HTML, Markdown, and JSON, see
// the Benchmarking section of README.md).
// Note #1: we build our demo and serve it (rather than use our development server), so that our plot gets benchmarked
//          as it gets used (e.g., without Vue's development checks).
// Note #2: we drive Chrome and Firefox using Puppeteer, and Safari using safaridriver (i.e. WebDriver), which comes
//          with Safari but needs to be enabled first (see README.md).
// Note #3: unless --capped is given, the frame rate of Chrome and Firefox is not capped by the refresh rate of the
//          display, so that it tells us how fast our plot can redraw itself. The frame rate of Safari cannot be
//          uncapped, so its redraw times are what tell us how fast our plot is.
// Note #4: Chrome is headless by default, but not Firefox, since headless Firefox doesn't draw using the GPU (e.g.,
//          Canvas 2D is about 4 times slower) and caps its frame rate.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import * as vite from 'vite';

import { BENCHMARK_INTERACTIONS, type BenchmarkReport, type BenchmarkScenario } from '../demo/benchmark';

// Our scenarios, i.e. what we benchmark.

interface Scenario extends BenchmarkScenario {
  id: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'smooth-3x1m', kind: 'smooth', traces: 3, points: 1_000_000, instances: 1 },
  { id: 'noisy-3x1m', kind: 'noisy', traces: 3, points: 1_000_000, instances: 1 },
  { id: 'steps-3x1m', kind: 'steps', traces: 3, points: 1_000_000, instances: 1 },
  { id: 'gaps-3x1m', kind: 'gaps', traces: 3, points: 1_000_000, instances: 1 },
  { id: 'large-offsets-3x1m', kind: 'largeOffsets', traces: 3, points: 1_000_000, instances: 1 },
  { id: 'noisy-3x10m', kind: 'noisy', traces: 3, points: 10_000_000, instances: 1 },
  { id: 'noisy-30x1m', kind: 'noisy', traces: 30, points: 1_000_000, instances: 1 },
  { id: 'noisy-100x1k', kind: 'noisy', traces: 100, points: 1_000, instances: 1 },
  { id: 'noisy-30x10k', kind: 'noisy', traces: 30, points: 10_000, instances: 1 },
  { id: 'noisy-100x10k', kind: 'noisy', traces: 100, points: 10_000, instances: 1 },
  { id: 'noisy-16-plots-3x100k', kind: 'noisy', traces: 3, points: 100_000, instances: 16 },
  { id: 'unsorted-3x100k', kind: 'unsorted', traces: 3, points: 100_000, instances: 1 },
  { id: 'unsorted-3x1m', kind: 'unsorted', traces: 3, points: 1_000_000, instances: 1 },
  { id: 'unsorted-10x100k', kind: 'unsorted', traces: 10, points: 100_000, instances: 1 },
  { id: 'unsorted-noisy-3x100k', kind: 'unsortedNoisy', traces: 3, points: 100_000, instances: 1 }
];

const BROWSERS = ['chrome', 'firefox', 'safari'] as const;
const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 900;
const DEVICE_SCALE_FACTOR = 2; // Device pixel ratio of Chrome and Firefox (Safari uses the one of the display).
const TIMEOUT = 30 * 60 * 1000; // Maximum time (in milliseconds) that a scenario may take.

type BrowserName = (typeof BROWSERS)[number];

// Our command line options.

const USAGE = `Usage: bun benchmark [options]

Options:
  --browsers <names>     Browsers to use: ${BROWSERS.join(', ')} (default: all of them, Safari only on macOS,
                         skipping those that cannot be launched)
  --scenarios <ids>      Scenarios to run (default: all of them, see --list)
  --capped               Cap the frame rate of Chrome and Firefox to the refresh rate of the display
  --headed               Show Chrome (Firefox and Safari are always shown)
  --chrome-path <path>   Path to Chrome (default: the installed stable version of Chrome)
  --firefox-path <path>  Path to Firefox (default: the usual location of Firefox on this platform)
  --output <directory>   Where to save our report (default: benchmark-results)
  --list                 List the scenarios and exit
  --help                 Show this help and exit`;

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const exitWithUsageError = (message: string): never => {
  // Report the given error with our command line, followed by our usage, and exit.

  console.error(`Error: ${message}\n\n${USAGE}`);

  process.exit(1);
};

const parsedArgs = (() => {
  try {
    return parseArgs({
      options: {
        browsers: { type: 'string' },
        scenarios: { type: 'string' },
        capped: { type: 'boolean', default: false },
        headed: { type: 'boolean', default: false },
        'chrome-path': { type: 'string' },
        'firefox-path': { type: 'string' },
        output: { type: 'string', default: 'benchmark-results' },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false }
      }
    });
  } catch (error: unknown) {
    return exitWithUsageError(errorMessage(error));
  }
})();
const options = parsedArgs.values;

const listOption = <T extends string>(name: string, value: string, allowedValues: readonly T[]): T[] => {
  // Return the comma-separated values of the given option, making sure that they are all allowed.

  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  for (const item of values) {
    if (!allowedValues.includes(item as T)) {
      exitWithUsageError(`Unknown ${name} '${item}' (expected one of: ${allowedValues.join(', ')}).`);
    }
  }

  return values as T[];
};

if (options.help) {
  console.log(USAGE);

  process.exit(0);
}

if (options.list) {
  for (const scenario of SCENARIOS) {
    console.log(
      `${scenario.id.padEnd(24)} ${scenario.instances} plot(s) of ${scenario.traces} ${scenario.kind} trace(s) of ${scenario.points.toLocaleString('en')} points`
    );
  }

  process.exit(0);
}

const browserNames = options.browsers
  ? listOption('browser', options.browsers, BROWSERS)
  : BROWSERS.filter((browser) => browser !== 'safari' || process.platform === 'darwin');
const scenarioIds = options.scenarios
  ? listOption(
      'scenario',
      options.scenarios,
      SCENARIOS.map((scenario) => scenario.id)
    )
  : SCENARIOS.map((scenario) => scenario.id);
const scenarios = SCENARIOS.filter((scenario) => scenarioIds.includes(scenario.id));

// A browser that runs the benchmark of our demo, i.e. Chrome or Firefox driven by Puppeteer, or Safari driven by
// safaridriver.

interface BenchmarkBrowser {
  description: () => Promise<string>;
  run: (scenario: BenchmarkScenario) => Promise<BenchmarkReport>;
  close: () => Promise<void>;
}

// What we evaluate in our demo, i.e. the description of our browser and the running of our benchmark (as the body of a
// function, so that it can be used with both Puppeteer and WebDriver).
// Note: the description of our browser includes its GPU (which Canvas 2D uses, if it is accelerated), which only WebGL
//       can tell us.

const DESCRIPTION_SCRIPT = `
  const context = document.createElement('canvas').getContext('webgl2');
  const extension = context?.getExtension('WEBGL_debug_renderer_info');
  const gpu = context ? (extension ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unknown GPU') : 'no WebGL 2';

  return \`\${navigator.userAgent} | \${gpu} | device pixel ratio: \${devicePixelRatio}\`;
`;
const IS_READY_EXPRESSION = `'demoBenchmark' in window`;

const firefoxPath = (): string => {
  // Return the usual location of Firefox on our platform.

  switch (process.platform) {
    case 'darwin':
      return '/Applications/Firefox.app/Contents/MacOS/firefox';
    case 'win32':
      return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
    default:
      return '/usr/bin/firefox';
  }
};

const killProcessesUsing = (directory: string): void => {
  // Kill the processes that use the given directory (e.g., a browser that Puppeteer lost track of), if any.

  if (process.platform === 'win32') {
    return;
  }

  for (const line of execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')) {
    if (line.includes(directory)) {
      try {
        process.kill(Number.parseInt(line, 10));
      } catch {
        // The process is already gone.
      }
    }
  }
};

const launchPuppeteerBrowser = async (name: 'chrome' | 'firefox', userDataDir: string): Promise<Browser> => {
  // Launch Chrome or Firefox using Puppeteer, using the given profile directory.

  const common = {
    headless: name === 'chrome' && !options.headed,
    defaultViewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR },
    protocolTimeout: TIMEOUT,
    userDataDir
  };

  return name === 'chrome'
    ? puppeteer.launch({
        ...common,
        ...(options['chrome-path'] ? { executablePath: options['chrome-path'] } : { channel: 'chrome' }),
        args: options.capped ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']
      })
    : puppeteer.launch({
        ...common,
        browser: 'firefox',
        executablePath: options['firefox-path'] ?? firefoxPath(),
        extraPrefsFirefox: {
          ...(options.capped ? {} : { 'layout.frame_rate': 0 }),
          'webgl.enable-debug-renderer-info': true
        }
      });
};

const puppeteerBrowser = async (name: 'chrome' | 'firefox', url: string): Promise<BenchmarkBrowser> => {
  // Launch Chrome or Firefox using Puppeteer and open our demo in it.
  // Note: we launch our browser with a profile directory of our own, so that we can clean up after it, even if it fails
  //       to launch (e.g., Firefox may restart itself when it gets launched, typically after having been updated, in
  //       which case Puppeteer loses track of it and reports a failure, but the restarted Firefox keeps running). If
  //       our browser fails to launch, then we try once more.

  let browser: Browser | undefined;
  let userDataDir = '';

  const cleanUp = (): void => {
    killProcessesUsing(userDataDir);

    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  for (let attempt = 1; !browser; ++attempt) {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `opencor-plot-benchmark-${name}-`));

    try {
      browser = await launchPuppeteerBrowser(name, userDataDir);
    } catch (error: unknown) {
      cleanUp();

      if (attempt === 2) {
        throw error;
      }

      console.log(`  Cannot launch ${name} (${errorMessage(error).split('\n')[0]?.trim()}), trying again...`);

      await delay(2000);
    }
  }

  const launchedBrowser = browser;
  let page: Page;

  try {
    page = await launchedBrowser.newPage();

    page.on('pageerror', (error: unknown) => {
      console.error(`  Page error: ${errorMessage(error)}`);
    });

    await page.goto(url);
    await page.waitForFunction(IS_READY_EXPRESSION, { timeout: TIMEOUT });
  } catch (error: unknown) {
    await launchedBrowser.close().catch(() => {});

    cleanUp();

    throw error;
  }

  return {
    description: async () => {
      return `${await launchedBrowser.version()} | ${await page.evaluate(`(() => {${DESCRIPTION_SCRIPT}})()`)}`;
    },
    run: (scenario: BenchmarkScenario) => {
      return page.evaluate(
        (scenario: BenchmarkScenario) =>
          (window as unknown as { demoBenchmark: import('../demo/benchmark').DemoBenchmark }).demoBenchmark.run(
            scenario
          ),
        scenario
      );
    },
    close: async () => {
      await launchedBrowser.close().catch(() => {});

      cleanUp();
    }
  };
};

const freePort = (): Promise<number> => {
  // Return a port that is free.

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port;

      server.close(() => {
        resolve(port);
      });
    });
  });
};

const delay = (duration: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
};

const safariBrowser = async (url: string): Promise<BenchmarkBrowser> => {
  // Launch Safari using safaridriver and open our demo in it.

  if (process.platform !== 'darwin') {
    throw new Error('Safari can only be used on macOS.');
  }

  const port = await freePort();
  const driver: ChildProcess = spawn('safaridriver', ['-p', String(port)], { stdio: 'ignore' });
  const driverUrl = `http://localhost:${port}`;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${driverUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: false // Note: Bun would otherwise time out after 5 minutes, which a scenario may take in Safari.
    });
    const json = (await response.json()) as { value: unknown };

    if (!response.ok) {
      const value = json.value as { error?: string; message?: string } | undefined;
      const details = [value?.error, value?.message].filter(Boolean).join(': ');

      throw new Error(`safaridriver (HTTP ${response.status}): ${details || JSON.stringify(json.value)}`);
    }

    return json.value;
  };

  // Wait for safaridriver to be ready, and create a session (i.e. open a Safari window).

  try {
    for (let i = 0; ; ++i) {
      try {
        await call('GET', '/status');

        break;
      } catch (error: unknown) {
        if (i === 50) {
          throw error;
        }

        await delay(100);
      }
    }
  } catch {
    driver.kill();

    throw new Error('Cannot start safaridriver (see the Benchmarking section of README.md).');
  }

  let sessionId: string;

  try {
    sessionId = (
      (await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })) as {
        sessionId: string;
      }
    ).sessionId;
  } catch (error: unknown) {
    driver.kill();

    throw error;
  }

  const session = (path: string): string => `/session/${sessionId}${path}`;
  const execute = (script: string, args: unknown[] = []): Promise<unknown> => {
    return call('POST', session('/execute/sync'), { script, args });
  };

  await call('POST', session('/timeouts'), { script: TIMEOUT });
  await call('POST', session('/window/rect'), { x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
  await call('POST', session('/url'), { url });

  while (!(await execute(`return ${IS_READY_EXPRESSION};`))) {
    await delay(100);
  }

  return {
    description: async () => {
      return `Safari | ${await execute(DESCRIPTION_SCRIPT)}`;
    },
    run: async (scenario: BenchmarkScenario) => {
      const result = (await call('POST', session('/execute/async'), {
        script: `
          const [scenario, done] = arguments;

          window.demoBenchmark.run(scenario).then(done, (error) => done({ error: String(error) }));
        `,
        args: [scenario]
      })) as BenchmarkReport & { error?: string };

      if (result.error) {
        throw new Error(result.error);
      }

      return result;
    },
    close: async () => {
      await call('DELETE', session('')).catch(() => {});

      driver.kill();
    }
  };
};

// Our report, i.e. our results for each of our browsers, which we save as HTML (to be opened in a browser), Markdown
// (e.g., to be pasted in an issue), and JSON (e.g., to be compared with other results), as we get them.

interface BrowserResults {
  browser: BrowserName;
  description: string;
  capped: boolean;
  results: { scenario: string; report: BenchmarkReport }[];
}

const report: BrowserResults[] = [];

const formatTime = (time: number): string => {
  return time.toFixed(1);
};

const HEADERS = ['Scenario', 'First draw', ...BENCHMARK_INTERACTIONS.map(([, label]) => label)];

const browserTitle = (browserResults: BrowserResults): string => {
  const name = browserResults.browser.charAt(0).toUpperCase() + browserResults.browser.slice(1);

  return `${name} (${browserResults.capped ? 'capped' : 'uncapped'} frame rate)`;
};

const markdownReport = (date: Date): string => {
  const lines = [
    '# OpenCOR Plot benchmark',
    '',
    `${date.toLocaleString('en')}. Each cell is the frame rate and the average/95th percentile redraw time.`
  ];

  for (const browserResults of report) {
    lines.push('', `## ${browserTitle(browserResults)}`, '', browserResults.description, '');
    lines.push(`| ${HEADERS.join(' | ')} |`, `| ${HEADERS.map(() => '---').join(' | ')} |`);

    for (const result of browserResults.results) {
      const cells = [
        result.scenario,
        `${Math.round(result.report.firstDraw)} ms`,
        ...BENCHMARK_INTERACTIONS.map(([name]) => {
          const interactionResult = result.report.results[name];

          if (!interactionResult) {
            return '—';
          }

          return `${Math.round(interactionResult.fps)} FPS, ${formatTime(interactionResult.redraw)}/${formatTime(interactionResult.redraw95)} ms`;
        })
      ];

      lines.push(`| ${cells.join(' | ')} |`);
    }
  }

  return `${lines.join('\n')}\n`;
};

const escapeHtml = (text: string): string => {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

const htmlReport = (date: Date): string => {
  const sections = report.map((browserResults) => {
    const rows = browserResults.results.map((result) => {
      const cells = BENCHMARK_INTERACTIONS.map(([name]) => {
        const interactionResult = result.report.results[name];

        if (!interactionResult) {
          return '<td>—</td>';
        }

        return `<td><span class="fps">${Math.round(interactionResult.fps)} FPS</span><span class="redraw">${formatTime(interactionResult.redraw)} / ${formatTime(interactionResult.redraw95)} ms</span></td>`;
      });

      return `<tr><th scope="row">${escapeHtml(result.scenario)}</th><td>${Math.round(result.report.firstDraw)} ms</td>${cells.join('')}</tr>`;
    });

    return `<section>
  <h2>${escapeHtml(browserTitle(browserResults))}</h2>
  <p class="description">${escapeHtml(browserResults.description)}</p>
  <div class="table">
    <table>
      <thead><tr>${HEADERS.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.join('\n        ')}
      </tbody>
    </table>
  </div>
</section>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCOR Plot benchmark</title>
<style>
  :root {
    color-scheme: light dark;
    --background: #fff;
    --text: #1e293b;
    --muted: #64748b;
    --border: #e2e8f0;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --background: #18181b;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --border: #3f3f46;
    }
  }

  body {
    margin: 0;
    padding: 24px 16px;
    background: var(--background);
    color: var(--text);
    font: 14px/1.5 system-ui, sans-serif;
  }

  h1 { margin: 0 0 4px; font-size: 22px; }
  h2 { margin: 32px 0 4px; font-size: 18px; }
  p { margin: 0 0 8px; color: var(--muted); }
  .description { font-size: 12px; overflow-wrap: anywhere; }
  .table { overflow-x: auto; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; vertical-align: top; }
  thead th { position: sticky; top: 0; background: var(--background); color: var(--muted); font-weight: 600; }
  .fps { display: block; font-weight: 600; }
  .redraw { display: block; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<h1>OpenCOR Plot benchmark</h1>
<p>${escapeHtml(date.toLocaleString('en'))}</p>
<p>Each cell is the frame rate and, below it, the average / 95th percentile of the redraw time. See the Benchmarking section of README.md for how to read these results.</p>
${sections.join('\n')}
</body>
</html>
`;
};

const reportFiles: string[] = [];

const saveReport = (date: Date, basePath: string): void => {
  // Save our report, as HTML, Markdown, and JSON.

  fs.mkdirSync(path.dirname(basePath), { recursive: true });

  reportFiles.length = 0;

  for (const [extension, contents] of [
    ['html', htmlReport(date)],
    ['md', markdownReport(date)],
    ['json', `${JSON.stringify(report, null, 2)}\n`]
  ]) {
    const file = `${basePath}.${extension}`;

    fs.writeFileSync(file, contents as string);

    reportFiles.push(file);
  }
};

// Build and serve our demo, run our scenarios in each of our browsers, and save our report (as we get our results, so
// that we have them even if something goes wrong or if we get interrupted).

const rootDirectory = path.join(import.meta.dirname, '..');
const configFile = path.join(rootDirectory, 'vite.config.ts');
const date = new Date();
const timestamp = [
  date.getFullYear(),
  date.getMonth() + 1,
  date.getDate(),
  date.getHours(),
  date.getMinutes(),
  date.getSeconds()
]
  .map((value) => String(value).padStart(2, '0'))
  .join('-');
const reportBasePath = path.resolve(options.output, timestamp);

// On macOS, a browser stops drawing frames when the display is off or the screen is locked, which would ruin our
// results (and get Safari to time out). So, we refuse to run if the screen is locked and otherwise turn the display on
// and keep it on (and the screen saver off) for as long as we are running.

if (process.platform === 'darwin') {
  if (/"CGSSessionScreenIsLocked"=Yes/.test(execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }))) {
    console.error('Error: the screen is locked, so our browsers would not draw anything. Unlock it and try again.');

    process.exit(1);
  }

  spawn('caffeinate', ['-d', '-i', '-u', '-t', '86400', '-w', String(process.pid)], { stdio: 'ignore' }).unref();
}

console.log('Building our demo...');

await vite.build({ configFile, logLevel: 'warn' });

const server = await vite.preview({ configFile, logLevel: 'warn', preview: { port: await freePort(), open: false } });
const url = server.resolvedUrls?.local[0];

process.once('SIGINT', () => {
  console.log('\nInterrupted.');

  if (reportFiles.length) {
    console.log(`Report (so far):\n  ${reportFiles.join('\n  ')}`);
  }

  process.exit(130);
});

try {
  if (!url) {
    throw new Error('Cannot serve our demo.');
  }

  for (const browserName of browserNames) {
    console.log(`Launching ${browserName}...`);

    // Launch our browser, skipping it if it cannot be launched (e.g., if it is not installed), unless it was explicitly
    // asked for.

    let browser: BenchmarkBrowser;

    try {
      browser = browserName === 'safari' ? await safariBrowser(url) : await puppeteerBrowser(browserName, url);
    } catch (error: unknown) {
      if (options.browsers) {
        throw error;
      }

      console.log(`  Skipping ${browserName}: ${errorMessage(error)}`);

      continue;
    }

    try {
      const browserResults: BrowserResults = {
        browser: browserName,
        description: await browser.description(),
        capped: browserName === 'safari' || options.capped,
        results: []
      };

      report.push(browserResults);

      for (const scenario of scenarios) {
        console.log(`  Running ${scenario.id}...`);

        const { id, ...benchmarkScenario } = scenario;

        browserResults.results.push({ scenario: id, report: await browser.run(benchmarkScenario) });

        saveReport(date, reportBasePath);
      }
    } finally {
      await browser.close();
    }
  }
} catch (error: unknown) {
  console.error(`Error: ${errorMessage(error)}`);

  process.exitCode = 1;
} finally {
  await server.close();

  if (reportFiles.length) {
    console.log(`Report:\n  ${reportFiles.join('\n  ')}`);
  }
}
