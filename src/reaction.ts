import { useState, useSyncExternalStore, useMemo, useRef } from "react";
import { produce, Draft } from "immer";
import { createScheduler } from "./scheduler";

// ==================== 1. 类型定义 ====================
export type DepSet = Set<Schedule>;

export interface Schedule {
  schedule: () => () => unknown | void;
  dependencies: Set<DepSet>;
}

export type SetValueType<S> = S | ((prevValue: S) => S);
export type SetterOrUpdater<T> = (value: T) => void;
type Extract<T> = () => T;

export const isFn = (x: any): x is Function => typeof x === "function";

// ==================== 2. 全局环境与批处理 ====================
const context: Schedule[] = [];
const batchQueue = new Set<() => void | unknown>();
let isBatching = false;

const runTaskAsync = createScheduler("channel");

function flushQueue() {
  isBatching = false;
  // ⚡ 优化：标准 while 队列消费，防止执行任务时向队列追加新任务导致遗漏
  while (batchQueue.size > 0) {
    const queue = Array.from(batchQueue);
    batchQueue.clear();
    for (const update of queue) {
      update();
    }
  }
}

function subscribeDep(schedule: Schedule, subscriptions: Set<Schedule>) {
  subscriptions.add(schedule);
  schedule.dependencies.add(subscriptions);
}

function cleanup(reaction: Schedule) {
  for (const dep of reaction.dependencies) {
    dep.delete(reaction);
  }
  reaction.dependencies.clear();
}

// ==================== 3. 核心 API 实现 ====================

export function createSignal<T>(initialValue: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  let value = initialValue; // 🟢 修正：这里原代码是直接改形参，闭包直接引用局部变量更稳固
  const subscriptions = new Set<Schedule>();

  const read = (): T => {
    const schedule = context[context.length - 1];
    if (schedule) subscribeDep(schedule, subscriptions);
    return value;
  };

  const write = (nextValue: SetValueType<T>) => {
    // ⚡ 优化：计算新值时短暂清空上下文，防止函数体内读 Signal 造成依赖污染
    const tempContext = [...context];
    context.length = 0;
    const newValue = isFn(nextValue) ? nextValue(value) : nextValue;
    context.push(...tempContext);

    if (!Object.is(newValue, value)) {
      value = newValue;
      // 变动时，同步将所有订阅者推入批处理队列
      for (const sub of Array.from(subscriptions)) {
        const updateFn = sub.schedule();
        if (updateFn) batchQueue.add(updateFn);
      }
      if (!isBatching && batchQueue.size > 0) {
        isBatching = true;
        runTaskAsync(flushQueue);
      }
    }
  };
  return [read, write];
}

export function createReaction() {
  let scheduleUpdate: (() => void | unknown) | null = null;
  
  const reaction: Schedule = {
    schedule: () => scheduleUpdate ?? (() => {}),
    dependencies: new Set<DepSet>(),
  };

  function track<R>(fn: () => R): R {
    cleanup(reaction);
    context.push(reaction);
    try {
      return fn();
    } catch (e) {
      cleanup(reaction);
      throw e;
    } finally {
      context.pop();
    }
  }

  function reconcile(fn: () => void | unknown) {
    scheduleUpdate = fn;
  }

  function dispose() {
    cleanup(reaction);
    scheduleUpdate = null;
  }

  return { track, reconcile, reaction, dispose };
}

export function useReaction<T, S = T>(fn: Extract<T>, selector?: (state: T) => S): S {
  const defaultSelector = (state: T) => state as unknown as S;
  const activeSelector = selector || defaultSelector;

  const latestFn = useRef(fn);
  const latestSelector = useRef(activeSelector);
  latestFn.current = fn;
  latestSelector.current = activeSelector;

  // ⚡ 优化：核心缓存结构，严格遵守 useSyncExternalStore 规范
  const storeMemo = useMemo(() => {
    const { track, reconcile, reaction } = createReaction();
    
    // 缓存上一次切片数据
    let lastSelectedState: S;
    let isInitialized = false;

    const runTrack = () => {
      return track(() => latestSelector.current(latestFn.current()));
    };

    const subscribe = (cb: () => void) => {
      // 当底层 Signal 通知改变时，触发 track 重新收集依赖，并运行 React 更新
      reconcile(() => {
        const nextState = runTrack();
        if (!Object.is(lastSelectedState, nextState)) {
          lastSelectedState = nextState;
          cb(); // 真正通知 React 更新
        }
      });
      return () => {
        cleanup(reaction);
      };
    };

    const getState = () => {
      // 初始化执行第一次依赖收集
      if (!isInitialized) {
        lastSelectedState = runTrack();
        isInitialized = true;
      }
      return lastSelectedState;
    };

    return { subscribe, getState };
  }, []);

  return useSyncExternalStore(storeMemo.subscribe, storeMemo.getState, storeMemo.getState);
}

export function useSignal<T>(initialValue: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  const [signal] = useState(() => createSignal<T>(initialValue));
  return signal;
}

export function create<T extends object>(initState: T) {
  const [state, setState] = createSignal<T>(initState);

  const useStore = <S = T>(selector?: (state: T) => S) => useReaction(state, selector);

  const dispatch = (recipe: (draft: Draft<T>) => void | T) => {
    const oldState = state();
    const nextState = produce(oldState, recipe);
    setState(nextState as T);
  };

  return { useStore, dispatch, getState: state };
}
