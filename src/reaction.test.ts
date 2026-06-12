import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  autorun,
  configureScheduler,
  createMemo,
  createReaction,
  createSignal,
  reaction,
  setErrorHandler,
  untracked,
} from "./reaction";
import { shallow } from "./shallow";

/**
 * 等待 scheduler flush 完成。我们把调度切到 microtask,等一个 microtask 即可。
 */
const flush = () => new Promise<void>((r) => queueMicrotask(r));

beforeEach(() => {
  // 整个测试套件使用 microtask 调度,保证 await flush() 能在当前 turn 拿到结果
  configureScheduler("microtask");
});

// -----------------------------------------------------------------------------
// createSignal
// -----------------------------------------------------------------------------

describe("createSignal", () => {
  it("read returns initial value", () => {
    const [read] = createSignal(42);
    expect(read()).toBe(42);
  });

  it("write updates the value", () => {
    const [read, write] = createSignal(0);
    write(1);
    expect(read()).toBe(1);
  });

  it("write accepts an updater function", () => {
    const [read, write] = createSignal(10);
    write((prev) => prev + 5);
    expect(read()).toBe(15);
  });

  it("does not notify subscribers when Object.is equal", async () => {
    const [count, setCount] = createSignal(1);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => count());

    setCount(1); // same value
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("custom equals option suppresses notification", async () => {
    const [arr, setArr] = createSignal([1, 2, 3], { equals: shallow });
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => arr());

    setArr([1, 2, 3]); // structurally equal under shallow
    await flush();
    expect(fn).not.toHaveBeenCalled();

    setArr([1, 2, 4]);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// createReaction
// -----------------------------------------------------------------------------

describe("createReaction", () => {
  it("track collects deps; write triggers reconcile callback", async () => {
    const [count, setCount] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => count());

    setCount(1);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("subscribes to multiple signals; any change triggers reaction", async () => {
    const [a, setA] = createSignal(0);
    const [b, setB] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => {
      a();
      b();
    });

    setA(1);
    await flush();
    setB(1);
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dispose stops further notifications", async () => {
    const [count, setCount] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile, dispose } = createReaction();
    reconcile(fn);
    track(() => count());

    dispose();
    setCount(1);
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("diff-based: signals dropped from track no longer notify", async () => {
    const [a, setA] = createSignal(0);
    const [b, setB] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);

    // first run: both a and b are deps
    track(() => {
      a();
      b();
    });

    // second run: only a is a dep — b should be unsubscribed
    track(() => {
      a();
    });

    setB(1);
    await flush();
    expect(fn).not.toHaveBeenCalled();

    setA(1);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("same signal read N times in one track is collected once (O(1) dedup)", async () => {
    const [count, setCount] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => {
      count();
      count();
      count();
    });

    setCount(1);
    await flush();
    // Should fire exactly once even though count was read 3 times
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// createMemo
// -----------------------------------------------------------------------------

describe("createMemo", () => {
  it("lazy: compute is not called until first read", () => {
    const compute = vi.fn(() => 42);
    const memo = createMemo(compute);
    expect(compute).not.toHaveBeenCalled();
    expect(memo()).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("eager recompute when deps change", async () => {
    const [first, setFirst] = createSignal("Ada");
    const [last] = createSignal("Lovelace");
    const compute = vi.fn(() => `${first()} ${last()}`);
    const memo = createMemo(compute);

    // initial read establishes deps and computes once
    expect(memo()).toBe("Ada Lovelace");

    // subscribe a downstream reaction so cache.signal write is observable
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => memo());

    setFirst("Grace");
    await flush();
    // memo recomputed, downstream notified
    expect(fn).toHaveBeenCalledTimes(1);
    expect(memo()).toBe("Grace Lovelace");
  });

  it("equality short-circuit: identical result does not notify downstream", async () => {
    const [n, setN] = createSignal(1);
    const memo = createMemo(() => n() * 0); // always 0

    expect(memo()).toBe(0);

    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => memo());

    setN(2); // memo result is still 0
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("dispose breaks the link to dependencies", async () => {
    const [count, setCount] = createSignal(0);
    const compute = vi.fn(() => count() * 2);
    const memo = createMemo(compute);
    expect(memo()).toBe(0);
    expect(compute).toHaveBeenCalledTimes(1);

    memo.dispose();
    setCount(5);
    await flush();
    // compute should not have been called again
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("lazy: dep change does NOT trigger immediate recompute", async () => {
    const [count, setCount] = createSignal(0);
    const compute = vi.fn(() => count() * 2);
    const memo = createMemo(compute, { lazy: true });

    expect(memo()).toBe(0);
    expect(compute).toHaveBeenCalledTimes(1);

    setCount(5);
    await flush();
    // dep changed but lazy memo waits for read
    expect(compute).toHaveBeenCalledTimes(1);

    // reading triggers recompute on demand
    expect(memo()).toBe(10);
    expect(compute).toHaveBeenCalledTimes(2);

    // reading again without dep change is cached
    expect(memo()).toBe(10);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("lazy: multiple dep changes between reads still produce one recompute", async () => {
    const [count, setCount] = createSignal(0);
    const compute = vi.fn(() => count());
    const memo = createMemo(compute, { lazy: true });
    expect(memo()).toBe(0);

    setCount(1);
    setCount(2);
    setCount(3);
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);

    expect(memo()).toBe(3);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("autoDispose: no observer → no dep subscription; with observer → subscribes", async () => {
    const [count, setCount] = createSignal(0);
    const compute = vi.fn(() => count() * 2);
    const memo = createMemo(compute, { autoDispose: true });

    // 未被 read — compute 还没跑(lazy 初始化)
    expect(compute).toHaveBeenCalledTimes(0);

    // 第一次 read 触发 compute(untracked 模式)
    expect(memo()).toBe(0);
    expect(compute).toHaveBeenCalledTimes(1);

    // dep change without observer: no auto-recompute
    setCount(1);
    await flush();
    expect(compute).toHaveBeenCalledTimes(1);

    // observer arrives — should connect and recompute
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => memo());
    // onConnect 触发一次 recompute(track 模式)
    expect(compute).toHaveBeenCalledTimes(2);

    // dep change with observer: triggers auto-recompute
    setCount(2);
    await flush();
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("autoDispose: dep changes after observer leaves are NOT recomputed until next observer", async () => {
    const [count, setCount] = createSignal(0);
    const compute = vi.fn(() => count());
    const memo = createMemo(compute, { autoDispose: true });

    // 1st observer
    const r1 = createReaction();
    r1.reconcile(() => undefined);
    r1.track(() => memo());
    expect(compute).toHaveBeenCalledTimes(2); // initial + onConnect recompute

    // 2nd observer to make r1's removal NOT the last one
    const r2 = createReaction();
    r2.reconcile(() => undefined);
    r2.track(() => memo());

    // remove r1 — not the last observer
    r1.dispose();
    // we still have r2 — but r1.dispose → cleanup → r1 is removed from memo.cache.deps.subs
    // but r2 still subscribes, so subs.size stays >= 1, onDisconnect does NOT fire

    setCount(1);
    await flush();
    // r2 is still observing, so recompute happened
    expect(compute).toHaveBeenCalledTimes(3);

    // remove r2 — last observer, onDisconnect fires
    r2.dispose();
    setCount(2);
    await flush();
    // no recompute — we are disconnected from deps
    expect(compute).toHaveBeenCalledTimes(3);
  });
});

// -----------------------------------------------------------------------------
// untracked
// -----------------------------------------------------------------------------

describe("untracked", () => {
  it("read inside untracked does not establish a dependency", async () => {
    const [a, setA] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);

    track(() => {
      untracked(() => a());
    });

    setA(1);
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the result of the inner function", () => {
    const [a] = createSignal(7);
    expect(untracked(() => a() * 2)).toBe(14);
  });
});

// -----------------------------------------------------------------------------
// configureScheduler
// -----------------------------------------------------------------------------

describe("configureScheduler", () => {
  it("microtask scheduler flushes within a microtask", async () => {
    configureScheduler("microtask");
    const [count, setCount] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => count());

    setCount(1);
    expect(fn).not.toHaveBeenCalled(); // not yet — scheduled
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("promise scheduler also flushes asynchronously", async () => {
    configureScheduler("promise");
    const [count, setCount] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => count());

    setCount(1);
    expect(fn).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve(); // one extra tick for safety
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Error isolation in flushReactions
// -----------------------------------------------------------------------------

describe("flushReactions error isolation", () => {
  let captured: unknown[];

  beforeEach(() => {
    captured = [];
    setErrorHandler((err) => captured.push(err));
  });

  afterEach(() => {
    setErrorHandler(null); // restore default
  });

  it("a single throwing reaction does not prevent others from running", async () => {
    const [count, setCount] = createSignal(0);

    const surviving = vi.fn();
    const r1 = createReaction();
    r1.reconcile(() => {
      throw new Error("boom");
    });
    r1.track(() => count());

    const r2 = createReaction();
    r2.reconcile(surviving);
    r2.track(() => count());

    setCount(1);
    await flush();

    expect(surviving).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe("boom");
  });
});

// -----------------------------------------------------------------------------
// Shallow + batching
// -----------------------------------------------------------------------------

describe("batching", () => {
  it("multiple writes within the same tick coalesce into one notification", async () => {
    const [count, setCount] = createSignal(0);
    const fn = vi.fn();
    const { track, reconcile } = createReaction();
    reconcile(fn);
    track(() => count());

    setCount(1);
    setCount(2);
    setCount(3);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// autorun
// -----------------------------------------------------------------------------

describe("autorun", () => {
  it("runs immediately and re-runs on dep change", async () => {
    const [count, setCount] = createSignal(0);
    const effect = vi.fn(() => count());

    const dispose = autorun(effect);
    expect(effect).toHaveBeenCalledTimes(1); // immediate

    setCount(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("dispose stops further runs", async () => {
    const [count, setCount] = createSignal(0);
    const effect = vi.fn(() => count());

    const dispose = autorun(effect);
    dispose();

    setCount(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(1); // only the initial run
  });

  it("dependencies update across runs (diff-based)", async () => {
    const [a, setA] = createSignal(0);
    const [b, setB] = createSignal(0);
    const [useA, setUseA] = createSignal(true);
    const effect = vi.fn(() => {
      if (useA()) a();
      else b();
    });

    const dispose = autorun(effect);
    expect(effect).toHaveBeenCalledTimes(1);

    // initially deps = { useA, a }; b should not trigger
    setB(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(1);

    setA(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(2);

    // now switch to reading b — deps become { useA, b }; a should no longer trigger
    setUseA(false);
    await flush();
    expect(effect).toHaveBeenCalledTimes(3);

    setA(2);
    await flush();
    expect(effect).toHaveBeenCalledTimes(3); // a is no longer a dep

    setB(2);
    await flush();
    expect(effect).toHaveBeenCalledTimes(4);

    dispose();
  });
});

// -----------------------------------------------------------------------------
// reaction
// -----------------------------------------------------------------------------

describe("reaction", () => {
  it("does NOT call effect on initial setup by default", async () => {
    const [count] = createSignal(0);
    const effect = vi.fn();

    const dispose = reaction(() => count(), effect);
    expect(effect).not.toHaveBeenCalled();

    dispose();
  });

  it("calls effect on initial setup when fireImmediately is true", async () => {
    const [count] = createSignal(5);
    const effect = vi.fn();

    const dispose = reaction(() => count(), effect, { fireImmediately: true });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith(5, undefined);

    dispose();
  });

  it("calls effect with (current, previous) on dep change", async () => {
    const [count, setCount] = createSignal(0);
    const effect = vi.fn();

    const dispose = reaction(() => count(), effect);

    setCount(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenLastCalledWith(1, 0);

    setCount(2);
    await flush();
    expect(effect).toHaveBeenCalledTimes(2);
    expect(effect).toHaveBeenLastCalledWith(2, 1);

    dispose();
  });

  it("custom equals option suppresses effect when deps result is equal", async () => {
    const [obj, setObj] = createSignal({ a: 1, b: 2 });
    const effect = vi.fn();

    const dispose = reaction(() => obj(), effect, { equals: shallow });

    setObj({ a: 1, b: 2 }); // shallow-equal
    await flush();
    expect(effect).not.toHaveBeenCalled();

    setObj({ a: 1, b: 3 });
    await flush();
    expect(effect).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("effect runs in untracked context — reads inside do NOT become deps", async () => {
    const [trigger, setTrigger] = createSignal(0);
    const [side, setSide] = createSignal(0);
    const effect = vi.fn(() => {
      // reading `side` here should not create a dependency
      side();
    });

    const dispose = reaction(() => trigger(), effect);

    setTrigger(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(1);

    // changing side should NOT trigger the reaction
    setSide(1);
    await flush();
    expect(effect).toHaveBeenCalledTimes(1);

    // changing the real dep should
    setTrigger(2);
    await flush();
    expect(effect).toHaveBeenCalledTimes(2);

    dispose();
  });

  it("dispose stops further effect calls", async () => {
    const [count, setCount] = createSignal(0);
    const effect = vi.fn();

    const dispose = reaction(() => count(), effect);
    dispose();

    setCount(1);
    await flush();
    expect(effect).not.toHaveBeenCalled();
  });

  it("delay option debounces effect calls", async () => {
    vi.useFakeTimers();
    try {
      const [count, setCount] = createSignal(0);
      const effect = vi.fn();
      const dispose = reaction(() => count(), effect, { delay: 100 });

      setCount(1);
      await flush();
      // effect scheduled but not yet fired
      expect(effect).not.toHaveBeenCalled();

      // change again within debounce window — timer resets
      vi.advanceTimersByTime(50);
      setCount(2);
      await flush();
      vi.advanceTimersByTime(50);
      expect(effect).not.toHaveBeenCalled(); // would have fired w/o reset

      // wait full delay
      vi.advanceTimersByTime(60);
      expect(effect).toHaveBeenCalledTimes(1);
      // effect sees the LATEST value at the time of scheduling — i.e. 2
      expect(effect).toHaveBeenLastCalledWith(2, 1);

      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delay option: dispose cancels pending effect", async () => {
    vi.useFakeTimers();
    try {
      const [count, setCount] = createSignal(0);
      const effect = vi.fn();
      const dispose = reaction(() => count(), effect, { delay: 100 });

      setCount(1);
      await flush();
      dispose();

      vi.advanceTimersByTime(200);
      expect(effect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
