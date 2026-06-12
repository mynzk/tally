import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { produce, type Producer } from "immer";
import { createScheduler } from "./scheduler";

export type DepSet = Set<Schedule>;

export interface Schedule {
  schedule: () => void | unknown;
  dependencies: Set<DepSet>;
  disposed: boolean;
}

export type SetValueType<S> = S | ((prevValue: S) => S);
export type SetterOrUpdater<T> = (value: T) => void;
type Extract<T> = () => T;
type Selector<T, S> = (state: T) => S;
type StoreUpdater<T extends object> = Partial<T> | T | Producer<T>;

const identitySelector = <T, S = T>(state: T) => state as unknown as S;
const noop = () => undefined;

// eslint-disable-next-line @typescript-eslint/ban-types
export const isFn = (x: unknown): x is Function => typeof x === "function";

const reactionStack: Schedule[] = [];
const pendingReactions = new Set<Schedule>();
let isFlushScheduled = false;
let globalVersion = 0;

const runTaskAsync = createScheduler("channel");

function getCurrentReaction() {
  return reactionStack[reactionStack.length - 1];
}

function bumpVersion() {
  globalVersion += 1;
}

function flushReactions() {
  try {
    while (pendingReactions.size > 0) {
      const queue = Array.from(pendingReactions);
      pendingReactions.clear();

      for (const reaction of queue) {
        if (!reaction.disposed) {
          reaction.schedule();
        }
      }
    }
  } finally {
    isFlushScheduled = false;

    if (pendingReactions.size > 0) {
      scheduleFlush();
    }
  }
}

function scheduleFlush() {
  if (isFlushScheduled) return;
  isFlushScheduled = true;
  runTaskAsync(flushReactions);
}

function enqueueReaction(reaction: Schedule) {
  if (reaction.disposed) return;
  pendingReactions.add(reaction);
  scheduleFlush();
}

function runWithoutTracking<T>(fn: () => T): T {
  const previousStack = reactionStack.splice(0, reactionStack.length);

  try {
    return fn();
  } finally {
    reactionStack.push(...previousStack);
  }
}

function subscribeDep(reaction: Schedule, subscriptions: DepSet) {
  if (reaction.disposed || subscriptions.has(reaction)) return;

  subscriptions.add(reaction);
  reaction.dependencies.add(subscriptions);
}

function cleanup(reaction: Schedule) {
  for (const dep of reaction.dependencies) {
    dep.delete(reaction);
  }
  reaction.dependencies.clear();
}

export function createSignal<T>(initialValue: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  let value = initialValue;
  const subscriptions = new Set<Schedule>();

  const read = (): T => {
    const reaction = getCurrentReaction();
    if (reaction) subscribeDep(reaction, subscriptions);

    return value;
  };

  const write = (nextValue: SetValueType<T>) => {
    const newValue = runWithoutTracking(() => (isFn(nextValue) ? nextValue(value) : nextValue));

    if (Object.is(newValue, value)) return;

    value = newValue;
    bumpVersion();

    for (const reaction of Array.from(subscriptions)) {
      enqueueReaction(reaction);
    }
  };

  return [read, write];
}

export function createReaction() {
  let scheduleUpdate: (() => void | unknown) = noop;

  const reaction: Schedule = {
    schedule: () => scheduleUpdate(),
    dependencies: new Set<DepSet>(),
    disposed: false,
  };

  function track<R>(fn: () => R): R {
    if (reaction.disposed) {
      return fn();
    }

    cleanup(reaction);
    reactionStack.push(reaction);

    try {
      return fn();
    } finally {
      reactionStack.pop();
    }
  }

  function reconcile(fn: () => void | unknown) {
    if (reaction.disposed) return;
    scheduleUpdate = fn;
  }

  function dispose() {
    if (reaction.disposed) return;

    reaction.disposed = true;
    scheduleUpdate = noop;
    pendingReactions.delete(reaction);
    cleanup(reaction);
  }

  return { track, reconcile, reaction, dispose };
}

export function useReaction<T, S = T>(fn: Extract<T>, selector?: Selector<T, S>): S {
  const latestFn = useRef(fn);
  const latestSelector = useRef<Selector<T, S>>(selector ?? identitySelector);
  latestFn.current = fn;
  latestSelector.current = selector ?? identitySelector;

  const storeMemo = useMemo(() => {
    const { track, reconcile, reaction } = createReaction();

    let snapshot: S;
    let snapshotVersion = -1;
    let snapshotFn = latestFn.current;
    let snapshotSelector = latestSelector.current;
    let hasSnapshot = false;

    const readSelected = () => track(() => latestSelector.current(latestFn.current()));

    const updateSnapshot = () => {
      const nextSnapshot = readSelected();
      const changed = !hasSnapshot || !Object.is(snapshot, nextSnapshot);

      snapshot = nextSnapshot;
      snapshotVersion = globalVersion;
      snapshotFn = latestFn.current;
      snapshotSelector = latestSelector.current;
      hasSnapshot = true;

      return changed;
    };

    const subscribe = (cb: () => void) => {
      reconcile(() => {
        if (updateSnapshot()) {
          cb();
        }
      });

      return () => {
        pendingReactions.delete(reaction);
        cleanup(reaction);
      };
    };

    const getSnapshot = () => {
      const inputsChanged =
        snapshotFn !== latestFn.current || snapshotSelector !== latestSelector.current;

      if (!hasSnapshot || snapshotVersion !== globalVersion || inputsChanged) {
        updateSnapshot();
      }

      return snapshot;
    };

    return { subscribe, getSnapshot };
  }, []);

  return useSyncExternalStore(storeMemo.subscribe, storeMemo.getSnapshot, storeMemo.getSnapshot);
}

export function useSignal<T>(initialValue: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  const [signal] = useState(() => createSignal<T>(initialValue));
  return signal;
}

export function create<T extends object>(initState: T) {
  const [state, setState] = createSignal<T>(initState);

  const useStore = <S = T>(selector?: Selector<T, S>) => useReaction(state, selector);

  const dispatch = (updater: StoreUpdater<T>) => {
    if (isFn(updater)) {
      const nextState = produce(state(), updater);
      setState(nextState as T);
      return;
    }

    setState((prevState) => ({ ...prevState, ...updater }));
  };

  return { useStore, dispatch, getState: state };
}
