// Micro-benchmarks for the @frada/tally core reactivity path.
// Run with: pnpm bench
//
// Self-contained (no extra deps). Reports min/median/p95/mean and ops/sec.
// Each benchmark runs N warmup iterations, then M timed iterations.

import { performance } from "node:perf_hooks";
import {
  configureScheduler,
  createMemo,
  createReaction,
  createSignal,
} from "../src/reaction";

// Force the synchronous-est scheduler so flush latency doesn't dominate measurements.
configureScheduler("microtask");

interface BenchResult {
  name: string;
  iters: number;
  min: number;
  median: number;
  p95: number;
  mean: number;
  opsPerSec: number;
}

function bench(name: string, iters: number, fn: () => void): BenchResult {
  // Warmup
  for (let i = 0; i < Math.min(100, iters); i++) fn();

  const samples: number[] = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }

  samples.sort((a, b) => a - b);
  const min = samples[0] ?? 0;
  const median = samples[Math.floor(iters / 2)] ?? 0;
  const p95 = samples[Math.floor(iters * 0.95)] ?? 0;
  let total = 0;
  for (const s of samples) total += s;
  const mean = total / iters;
  const opsPerSec = mean > 0 ? 1000 / mean : Infinity;

  return { name, iters, min, median, p95, mean, opsPerSec };
}

function report(results: BenchResult[]): void {
  const pad = (s: string, n: number) => s.padStart(n);
  const fmt = (n: number) => (n >= 1 ? n.toFixed(3) : n.toFixed(5));
  const fmtOps = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);

  console.log(
    pad("name", 45),
    pad("iters", 8),
    pad("min(ms)", 10),
    pad("median", 10),
    pad("p95", 10),
    pad("mean", 10),
    pad("ops/s", 12),
  );
  console.log("-".repeat(110));
  for (const r of results) {
    console.log(
      pad(r.name, 45),
      pad(String(r.iters), 8),
      pad(fmt(r.min), 10),
      pad(fmt(r.median), 10),
      pad(fmt(r.p95), 10),
      pad(fmt(r.mean), 10),
      pad(fmtOps(r.opsPerSec), 12),
    );
  }
}

// ─── Benchmark 1: signal write that nobody observes ─────────────────────────
// Lower bound — what does a write cost when there are no subscribers?
function benchSilentWrite(): BenchResult {
  const [, setCount] = createSignal(0);
  let i = 0;
  return bench("silent write (no subscribers)", 100_000, () => {
    setCount(++i);
  });
}

// ─── Benchmark 2: signal write with N fan-out reactions ─────────────────────
function benchFanoutWrite(fanout: number): BenchResult {
  const [count, setCount] = createSignal(0);
  for (let i = 0; i < fanout; i++) {
    const { track, reconcile } = createReaction();
    reconcile(() => undefined);
    track(() => count());
  }
  let i = 0;
  return bench(`write fan-out → ${fanout} reactions`, 10_000, () => {
    setCount(++i);
  });
}

// ─── Benchmark 3: track re-run with stable deps (diff-based win) ────────────
// Each track call re-reads the same N signals. With diff-based tracking,
// the second+ run should incur ~zero Set churn.
function benchStableTrack(depCount: number): BenchResult {
  const signals: Array<() => number> = [];
  for (let i = 0; i < depCount; i++) {
    const [read] = createSignal(i);
    signals.push(read);
  }
  const { track, reconcile } = createReaction();
  reconcile(() => undefined);

  return bench(`track re-run, ${depCount} stable deps`, 50_000, () => {
    track(() => {
      for (const s of signals) s();
    });
  });
}

// ─── Benchmark 4: createMemo recompute on dep change ────────────────────────
function benchMemoRecompute(): BenchResult {
  const [first, setFirst] = createSignal("Ada");
  const [last] = createSignal("Lovelace");
  const memo = createMemo(() => `${first()} ${last()}`);
  // prime
  memo();

  let i = 0;
  return bench("memo recompute on dep change", 50_000, () => {
    setFirst(`Ada${++i}`);
    memo(); // force lazy path; eager recompute is scheduled
  });
}

// ─── Benchmark 5: memo equality short-circuit ───────────────────────────────
// Dep changes but memo result does not — downstream should be untouched.
function benchMemoShortCircuit(): BenchResult {
  const [n, setN] = createSignal(0);
  const memo = createMemo(() => n() * 0); // always 0
  memo();

  let i = 0;
  return bench("memo short-circuit (result unchanged)", 50_000, () => {
    setN(++i);
    memo();
  });
}

// ─── Benchmark 6: createReaction allocation ─────────────────────────────────
function benchReactionAlloc(): BenchResult {
  return bench("createReaction() allocation", 100_000, () => {
    const r = createReaction();
    r.dispose();
  });
}

// ─── Benchmark 7: createSignal allocation ───────────────────────────────────
function benchSignalAlloc(): BenchResult {
  return bench("createSignal() allocation", 100_000, () => {
    createSignal(0);
  });
}

// ─── Run all ────────────────────────────────────────────────────────────────
const results: BenchResult[] = [];

console.log("\n@frada/tally micro-benchmarks");
console.log(`node ${process.version} · ${process.platform}/${process.arch}\n`);

results.push(benchSilentWrite());
results.push(benchSignalAlloc());
results.push(benchReactionAlloc());
results.push(benchFanoutWrite(10));
results.push(benchFanoutWrite(100));
results.push(benchFanoutWrite(1000));
results.push(benchStableTrack(10));
results.push(benchStableTrack(100));
results.push(benchStableTrack(1000));
results.push(benchMemoRecompute());
results.push(benchMemoShortCircuit());

report(results);

console.log("\nNotes:");
console.log("  · stable-deps track measures the diff-based optimization win:");
console.log("    second+ run should be ~free since no DepSet write occurs.");
console.log("  · fan-out write measures the cost of iterating subs + enqueueing.");
console.log("  · memo short-circuit measures the equality check skipping downstream notify.");
