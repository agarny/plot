import type { PlotRenderer } from '../index';
import type { DataKind } from './data';

// What our benchmark script (see scripts/benchmark.ts) needs to know about our demo's benchmark (see App.vue), i.e. its
// interactions, what it can be run for (a scenario), and what it reports.

export const BENCHMARK_PAN_ZOOMS = [1, 10, 100]; // Zooms at which we pan our instances.

export const BENCHMARK_INTERACTIONS: [name: string, label: string][] = [
  ['zoom', 'Zoom'],
  ...BENCHMARK_PAN_ZOOMS.map((zoom): [string, string] => [`pan${zoom}`, `Pan (${zoom}×)`]),
  ['live', 'Live'],
  ['resize', 'Resize']
];

export interface BenchmarkScenario {
  kind: DataKind; // Kind of data (e.g., noisy sine waves or unsorted Lissajous curves).
  traces: number; // Number of traces per instance.
  points: number; // Number of points per trace.
  instances: number; // Number of instances of our plot.
  renderer: PlotRenderer; // Renderer to use (e.g., "canvas" or "webgl").
}

export interface BenchmarkResult {
  fps: number; // Frame rate (in frames per second).
  redraw: number; // Average redraw time of our instances (in milliseconds).
  redraw95: number; // 95th percentile of the redraw time of our instances (in milliseconds).
}

export interface BenchmarkReport {
  results: Record<string, BenchmarkResult>; // Results of our interactions, by name (see BENCHMARK_INTERACTIONS).
  drawnUsing: string; // What our traces got drawn using (e.g., "Canvas 2D" or "WebGL").
  firstDraw: number; // Time to first draw of our data (in milliseconds).
}

export interface DemoBenchmark {
  run: (scenario: BenchmarkScenario) => Promise<BenchmarkReport>; // Run our interactions for the given scenario.
}
