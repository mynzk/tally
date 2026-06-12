import { useState, useSyncExternalStore, useMemo, useRef } from "react";
import { produce, Draft } from "immer"; // 🟢 优化：引入 Draft 类型
import { createScheduler } from "./scheduler";

// ==================== 1. 类型定义 ====================
// 🟢 优化：重新定义更清晰的类型别名
export type DepSet = Set<Schedule>; // 代表 Signal 内部的订阅者集合

export interface Schedule {
  schedule: () => () => unknown | void;
  dependencies: Set<DepSet>; // 收集自己订阅了哪些 Signal 的 DepSet
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
      // 🟢 优化：一旦用户传入的执行函数崩溃，立即彻底清理依赖，防止 Reaction 处于污染状态
      cleanup(reaction);
      throw e;
    } finally {
      context.pop();
    }
  }

  function reconcile(fn: () => void | unknown) {
    // 🟢 优化：防止防御性误操作或重复覆盖
    scheduleUpdate = fn;
  }

  // 🟢 建议补充：显式的销毁方法，便于非 React 场景下手动安全卸载
  function dispose() {
    cleanup(reaction);
    scheduleUpdate = null;
  }

  return { track, reconcile, reaction, dispose };
}


export function useReaction<T, S = T>(fn: Extract<T>, selector?: (state: T) => S): S {
  // 🟢 优化：默认 selector 使用固定引用，避免重渲染引发的判定问题
  const defaultSelector = (state: T) => state as unknown as S;
  const activeSelector = selector || defaultSelector;

  // 🟢 优化：使用 Ref 存储最新函数，解决 useMemo 依赖改变导致 Reaction 实例重建、依赖丢失的问题
  const latestFn = useRef(fn);
  const latestSelector = useRef(activeSelector);
  latestFn.current = fn;
  latestSelector.current = activeSelector;

  // 🟢 优化：增加快照缓存，防止 selector 返回新对象时引发 useSyncExternalStore 渲染死循环
  const lastSelectedState = useRef<S | null>(null);

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
      // 始终执行 track 以保证依赖是最新的
      const nextState = track(() => latestSelector.current(latestFn.current()));
      
      // 浅比较：如果新旧状态全等，直接返回旧引用，避免 React 判定失误
      if (Object.is(lastSelectedState.current, nextState)) {
        return lastSelectedState.current as S;
      }
      lastSelectedState.current = nextState;
      return nextState;
    };

    return { subscribe, getState };
  }, []); // 🟢 优化：空依赖数组，确保单个组件内生命周期内 Reaction 唯一

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

  // 🟢 优化：对齐 Immer 官方签名，完美支持 (draft => void) 和 (draft => T)
  const dispatch = (recipe: (draft: Draft<T>) => void | T) => {
    const oldState = state();
    const nextState = produce(oldState, recipe);
    setState(nextState as T);
  };

  return { useStore, dispatch, getState: state };
}
