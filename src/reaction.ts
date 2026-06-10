// signalStore.ts
import { useState, useSyncExternalStore, useMemo } from "react";
import { produce } from "immer"; // 🟢 引入 Immer 核心方法
import { createScheduler } from "./scheduler";

// ==================== 1. 类型定义 ====================
export interface Schedule {
  schedule: () => () => unknown | void;
  dependencies: Set<Set<Schedule>>;
}

export type SetValueType<S> = S | ((prevValue: S) => S);
export type SetterOrUpdater<T> = (value: T) => void;
type Extract<T> = () => T;

// eslint-disable-next-line @typescript-eslint/ban-types
export const isFn = (x: any): x is Function => typeof x === "function";

// ==================== 2. 全局环境与批处理 ====================
const context: Schedule[] = [];
const batchQueue = new Set<() => void | unknown>();
let isBatching = false;

// 采用 MessageChannel 宏任务模型，优化大表单连续打字手感
const runTaskAsync = createScheduler("channel");

function flushQueue() {
  const queue = Array.from(batchQueue);
  batchQueue.clear();
  isBatching = false;
  for (const update of queue) {
    update();
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

export function createSignal<T>(value: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  const subscriptions = new Set<Schedule>();

  const read = (): T => {
    const schedule = context[context.length - 1];
    if (schedule) subscribeDep(schedule, subscriptions);
    return value;
  };

  const write = (nextValue: SetValueType<T>) => {
    const newValue = isFn(nextValue) ? nextValue(value) : nextValue;
    if (!Object.is(newValue, value)) {
      value = newValue;
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
  let scheduleUpdate!: () => void | unknown;
  const reaction: Schedule = {
    schedule: () => scheduleUpdate,
    dependencies: new Set<Set<Schedule>>(),
  };

  function track<R>(fn: () => R): R {
    cleanup(reaction);
    context.push(reaction);
    try {
      return fn();
      // eslint-disable-next-line no-useless-catch
    } catch (e) {
      throw e;
    } finally {
      context.pop();
    }
  }

  function reconcile(fn: () => void | unknown) {
    scheduleUpdate = fn;
  }
  return { track, reconcile, reaction };
}

export function useReaction<T, S = T>(fn: Extract<T>, selector?: (state: T) => S): S {
  const activeSelector = selector || ((state: T) => state as unknown as S);

  const { subscribe, getState } = useMemo(() => {
    let updateCallback: (() => void) | null = null;
    const { track, reconcile, reaction } = createReaction();

    reconcile(() => updateCallback?.());

    const subscribe = (cb: () => void) => {
      updateCallback = cb;
      return () => {
        updateCallback = null;
        cleanup(reaction);
      };
    };

    const getState = () => {
      return track(() => activeSelector(fn()));
    };

    return { subscribe, getState };
  }, [fn, activeSelector]);

  return useSyncExternalStore(subscribe, getState, getState);
}

export function useSignal<T>(initialValue: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  const [signal] = useState(() => createSignal<T>(initialValue));
  return signal;
}

/**
 * 🟢 满血版：整合 Immer 的 Store 创建器
 */
export function create<T extends object>(initState: T) {
  const [state, setState] = createSignal<T>(initState);

  const useStore = <S = T>(selector?: (state: T) => S) => useReaction(state, selector);

  /**
   * 升级后的 dispatch
   * 接收一个 Immer 的 recipe 纯函数 (draft => void)
   * 允许通过直接修改草稿对象的语法，安全生成全新的不可变状态快照
   */
  const dispatch = (recipe: (draft: T) => void | T) => {
    const oldState = state();
    // 使用 immer 生成深度更新后的全新 immutable 对象
    const nextState = produce(oldState, recipe);
    setState(nextState);
  };

  return { useStore, dispatch, getState: state };
}
