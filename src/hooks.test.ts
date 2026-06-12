// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import {
  configureScheduler,
  create,
  createSignal,
  useReaction,
  useShallow,
  useSignal,
} from "./reaction";
import { shallow } from "./shallow";

/**
 * Use microtask scheduler so awaiting a Promise.resolve() drains the queue.
 * MessageChannel may not be available in every jsdom version.
 */
beforeEach(() => {
  configureScheduler("microtask");
});

afterEach(() => {
  cleanup();
});

/**
 * Helper: write a signal and let React flush its work.
 * Wrap the write in act() so React's internal effects run.
 */
const writeAndFlush = async (writer: () => void) => {
  await act(async () => {
    writer();
    // give the microtask scheduler a turn
    await Promise.resolve();
  });
};

// -----------------------------------------------------------------------------
// useSignal
// -----------------------------------------------------------------------------

describe("useSignal", () => {
  it("returns a stable [read, write] pair across renders", () => {
    const { result, rerender } = renderHook(() => useSignal(0));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(typeof first[0]).toBe("function");
    expect(typeof first[1]).toBe("function");
  });

  it("read returns the latest value after write", async () => {
    const { result } = renderHook(() => {
      const [read, write] = useSignal(0);
      return { read, write };
    });
    expect(result.current.read()).toBe(0);
    await writeAndFlush(() => result.current.write(1));
    expect(result.current.read()).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// useReaction
// -----------------------------------------------------------------------------

describe("useReaction", () => {
  it("subscribes to a signal and re-renders on write", async () => {
    const [count, setCount] = createSignal(0);
    const { result } = renderHook(() => useReaction(count));
    expect(result.current).toBe(0);

    await writeAndFlush(() => setCount(1));
    expect(result.current).toBe(1);
  });

  it("only re-renders when the SELECTED slice changes", async () => {
    const [state, setState] = createSignal({ a: 0, b: 0 });
    const renderCount = vi.fn();
    const { result } = renderHook(() => {
      renderCount();
      return useReaction(state, (s) => s.a);
    });
    expect(result.current).toBe(0);
    expect(renderCount).toHaveBeenCalledTimes(1);

    // change unrelated slice → no re-render
    await writeAndFlush(() => setState({ a: 0, b: 1 }));
    expect(renderCount).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(0);

    // change selected slice → re-render
    await writeAndFlush(() => setState({ a: 1, b: 1 }));
    expect(renderCount).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(1);
  });

  it("uses Object.is equality by default — same reference no re-render", async () => {
    const [s, setS] = createSignal({ v: 1 });
    const renderCount = vi.fn();
    const { result } = renderHook(() => {
      renderCount();
      return useReaction(s);
    });
    expect(renderCount).toHaveBeenCalledTimes(1);

    // same reference → write is skipped at the signal level
    await writeAndFlush(() => setS(result.current));
    expect(renderCount).toHaveBeenCalledTimes(1);
  });

  it("custom equalityFn (shallow) keeps reference stable across structurally-equal updates", async () => {
    const [s, setS] = createSignal({ a: 1, b: 2 });
    const renderCount = vi.fn();
    const { result } = renderHook(() => {
      renderCount();
      return useReaction(s, (state) => ({ a: state.a, b: state.b }), shallow);
    });
    expect(renderCount).toHaveBeenCalledTimes(1);
    const first = result.current;

    // new object reference but shallow-equal → no re-render, same reference
    await writeAndFlush(() => setS({ a: 1, b: 2 }));
    expect(renderCount).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(first);

    // actual change → re-render, new reference
    await writeAndFlush(() => setS({ a: 1, b: 3 }));
    expect(renderCount).toHaveBeenCalledTimes(2);
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ a: 1, b: 3 });
  });

  it("unmount cleans up: subsequent writes do not call into React", async () => {
    const [count, setCount] = createSignal(0);
    const { result, unmount } = renderHook(() => useReaction(count));
    expect(result.current).toBe(0);

    unmount();

    // After unmount, writing should be safe (no React warnings about setState on unmounted)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await writeAndFlush(() => setCount(1));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// -----------------------------------------------------------------------------
// useShallow
// -----------------------------------------------------------------------------

describe("useShallow", () => {
  it("returns previous reference for shallow-equal selector output", async () => {
    const [s, setS] = createSignal({ a: 1, b: 2, c: 3 });
    const renderCount = vi.fn();
    const { result } = renderHook(() => {
      renderCount();
      return useReaction(
        s,
        useShallow((state) => ({ a: state.a, b: state.b })),
      );
    });
    const first = result.current;
    expect(first).toEqual({ a: 1, b: 2 });

    // c changes but selected slice does not
    await writeAndFlush(() => setS({ a: 1, b: 2, c: 99 }));
    expect(renderCount).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(first);

    // b changes
    await writeAndFlush(() => setS({ a: 1, b: 5, c: 99 }));
    expect(renderCount).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ a: 1, b: 5 });
  });
});

// -----------------------------------------------------------------------------
// create() + useStore + dispatch
// -----------------------------------------------------------------------------

describe("create() + useStore + dispatch", () => {
  it("useStore selector re-renders only on selected slice change", async () => {
    const store = create({ count: 0, name: "Ada" });
    const renderCount = vi.fn();
    const { result } = renderHook(() => {
      renderCount();
      return store.useStore((s) => s.count);
    });
    expect(result.current).toBe(0);

    // name change should not re-render the counter
    await writeAndFlush(() => store.dispatch({ name: "Grace" }));
    expect(renderCount).toHaveBeenCalledTimes(1);

    // count change should
    await writeAndFlush(() => store.dispatch({ count: 1 }));
    expect(renderCount).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(1);
  });

  it("dispatch with immer producer mutates draft", async () => {
    const store = create({ items: [1, 2, 3] });
    const { result } = renderHook(() => store.useStore((s) => s.items));
    expect(result.current).toEqual([1, 2, 3]);

    await writeAndFlush(() =>
      store.dispatch((draft) => {
        draft.items.push(4);
      }),
    );
    expect(result.current).toEqual([1, 2, 3, 4]);
  });

  it("subscribe receives state on external change", async () => {
    const store = create({ count: 0 });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    await writeAndFlush(() => store.dispatch({ count: 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ count: 1 }, { count: 0 });

    unsub();
    await writeAndFlush(() => store.dispatch({ count: 2 }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("subscribe with selector: only fires when selected slice changes", async () => {
    const store = create({ a: 0, b: 0 });
    const listener = vi.fn();
    const unsub = store.subscribe(
      (s) => s.a,
      (current, prev) => listener(current, prev),
    );

    await writeAndFlush(() => store.dispatch({ b: 1 })); // b changes — not selected
    expect(listener).not.toHaveBeenCalled();

    await writeAndFlush(() => store.dispatch({ a: 1 })); // a changes — selected
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1, 0);

    unsub();
  });

  it("subscribe with selector + fireImmediately: calls once on init", async () => {
    const store = create({ count: 5 });
    const listener = vi.fn();
    const unsub = store.subscribe(
      (s) => s.count,
      (current) => listener(current),
      { fireImmediately: true },
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(5);

    await writeAndFlush(() => store.dispatch({ count: 6 }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(6);

    unsub();
  });

  it("subscribe with selector + equalityFn (shallow): suppresses equal slices", async () => {
    const store = create({ tags: ["a", "b"] });
    const listener = vi.fn();
    const unsub = store.subscribe(
      (s) => s.tags.slice(),
      (slice) => listener(slice),
      { equalityFn: shallow },
    );

    // new array with shallow-equal content — should NOT fire
    await writeAndFlush(() => store.dispatch({ tags: ["a", "b"] }));
    expect(listener).not.toHaveBeenCalled();

    // actual change
    await writeAndFlush(() => store.dispatch({ tags: ["a", "b", "c"] }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(["a", "b", "c"]);

    unsub();
  });

  it("dispose makes dispatch a no-op and unsubscribes external listeners", async () => {
    const store = create({ count: 0 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispose();

    await writeAndFlush(() => store.dispatch({ count: 99 }));
    expect(store.getState().count).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Component integration
// -----------------------------------------------------------------------------

describe("component integration", () => {
  it("two components subscribing to disjoint slices render independently", async () => {
    const store = create({ a: 0, b: 0 });
    const renderA = vi.fn();
    const renderB = vi.fn();

    const A = () => {
      renderA();
      return createElement("span", null, String(store.useStore((s) => s.a)));
    };
    const B = () => {
      renderB();
      return createElement("span", null, String(store.useStore((s) => s.b)));
    };

    render(createElement("div", null, createElement(A, null), createElement(B, null)));

    expect(renderA).toHaveBeenCalledTimes(1);
    expect(renderB).toHaveBeenCalledTimes(1);

    await writeAndFlush(() => store.dispatch({ a: 1 }));
    expect(renderA).toHaveBeenCalledTimes(2);
    expect(renderB).toHaveBeenCalledTimes(1); // B's slice unchanged

    await writeAndFlush(() => store.dispatch({ b: 1 }));
    expect(renderA).toHaveBeenCalledTimes(2);
    expect(renderB).toHaveBeenCalledTimes(2);
  });
});
