import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { produce, type Draft } from "immer";
import { createScheduler, type ScheduleFn, type SchedulerType } from "./scheduler";
import { shallow } from "./shallow";

export type { SchedulerType };

/** Immer producer: 接受 draft,可选返回新值(否则原地 mutate)。跨 immer 9/10/11 版本稳定。 */
export type Producer<T> = (draft: Draft<T>) => Draft<T> | void;

/**
 * 一个 signal 的"被观察集":对外仅暴露 subs 用于 write 时通知,
 * lastAccessedBy 用于 reaction 一次 track 内 O(1) 去重。
 * onConnect / onDisconnect 在 subs.size 跨 0↔1 边沿时触发,用于 auto-disposable memo 等场景。
 * @internal
 */
export interface DepSet {
  subs: Set<Schedule>;
  lastAccessedBy: number;
  /** subs 从 0 变 1 时调用 */
  onConnect?: () => void;
  /** subs 从 1 变 0 时调用 */
  onDisconnect?: () => void;
}

/** @internal */
export interface Schedule {
  schedule: () => void | unknown;
  /** 本轮 track 结束后的活跃依赖,Array 形式,只在 track finally 中重写。 */
  dependencies: DepSet[];
  /** 当 track 正在运行时,本次 run 期间收集到的依赖;否则为 null。 */
  newDependencies: DepSet[] | null;
  /** 当前 track 的递增 ID;subscribeDep 用它做 O(1) dedup。 */
  runId: number;
  /** O(1) dedup 标记:已在 pendingReactions 队列中,避免重复入队。 */
  inPending: boolean;
  disposed: boolean;
}

export type SetValueType<S> = S | ((prevValue: S) => S);
export type SetterOrUpdater<T> = (value: T) => void;
export type EqualityFn<S> = (a: S, b: S) => boolean;
type Extract<T> = () => T;
type Selector<T, S> = (state: T) => S;
type StoreUpdater<T extends object> = Partial<T> | T | Producer<T>;

const identitySelector = <T, S = T>(state: T) => state as unknown as S;
const noop = () => undefined;

export const isFn = (x: unknown): x is (...args: never[]) => unknown =>
  typeof x === "function";

let currentReaction: Schedule | null = null;
const pendingReactions: Schedule[] = [];
let isFlushScheduled = false;
let trackingSuspended = 0;
let runIdCounter = 0;

let runTaskAsync: ScheduleFn = createScheduler("channel");

/** 默认错误处理:异步抛出,让全局 error handler / unhandledException 捕获,不阻塞其他 reaction。 */
const defaultErrorHandler = (err: unknown): void => {
  queueMicrotask(() => {
    throw err;
  });
};

let errorHandler: (err: unknown) => void = defaultErrorHandler;

/**
 * 全局配置批处理调度引擎(channel / promise / microtask)。
 * 应在应用启动时一次性调用;运行中切换不会影响已排队的 flush。
 */
export function configureScheduler(type: SchedulerType): void {
  runTaskAsync = createScheduler(type);
}

/**
 * 设置 reaction 调度时的错误处理回调。
 * 默认:queueMicrotask 抛出,被全局 unhandledException 捕获。
 * 推荐生产环境注入自定义 handler(例如发送到 Sentry / 监控平台)。
 *
 * @example
 * setErrorHandler((err) => Sentry.captureException(err));
 */
export function setErrorHandler(handler: ((err: unknown) => void) | null): void {
  errorHandler = handler ?? defaultErrorHandler;
}

function getCurrentReaction() {
  if (trackingSuspended > 0) return null;
  return currentReaction;
}

/**
 * 递增并返回新的 track runId。
 * Number.MAX_SAFE_INTEGER 是 2^53 - 1;按微秒级触达需 ~285 年,实际不可触发。
 * 防御性抛错,避免静默环回导致 DepSet.lastAccessedBy 假命中。
 */
function nextRunId(): number {
  if (runIdCounter >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "[tally] runId counter overflow. This indicates a runaway tracking session.",
    );
  }
  return ++runIdCounter;
}

function flushReactions() {
  try {
    while (pendingReactions.length > 0) {
      // 拷贝一份切片用于本轮迭代,清空主队列;新入队的 reaction 进入下一轮
      const queue = pendingReactions.slice();
      pendingReactions.length = 0;

      for (const reaction of queue) {
        reaction.inPending = false;
        if (reaction.disposed) continue;

        try {
          reaction.schedule();
        } catch (err) {
          // 隔离单 reaction 错误:交给可配置的 errorHandler 上报,不中断其余调度
          errorHandler(err);
        }
      }
    }
  } finally {
    isFlushScheduled = false;

    if (pendingReactions.length > 0) {
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
  if (reaction.disposed || reaction.inPending) return;
  reaction.inPending = true;
  pendingReactions.push(reaction);
  scheduleFlush();
}

function runWithoutTracking<T>(fn: () => T): T {
  trackingSuspended++;

  try {
    return fn();
  } finally {
    trackingSuspended--;
  }
}

function subscribeDep(reaction: Schedule, deps: DepSet) {
  if (reaction.disposed) return;

  const newDeps = reaction.newDependencies;
  // 仅在 track 周期内收集依赖;非 track 上下文不应触发(getCurrentReaction 已守护)
  if (newDeps === null) return;

  // 版本号 dedup:同一次 track 内多次读同一 signal 只记录一次
  if (deps.lastAccessedBy === reaction.runId) return;
  deps.lastAccessedBy = reaction.runId;

  newDeps.push(deps);
  // Set.add 幂等;reaction 已订阅则 no-op
  const wasEmpty = deps.subs.size === 0;
  deps.subs.add(reaction);
  if (wasEmpty && deps.onConnect) {
    deps.onConnect();
  }
}

function cleanup(reaction: Schedule) {
  const deps = reaction.dependencies;
  for (const dep of deps) {
    dep.subs.delete(reaction);
    if (dep.subs.size === 0 && dep.onDisconnect) {
      dep.onDisconnect();
    }
  }
  reaction.dependencies = [];
}

export interface CreateSignalOptions<T> {
  /** 自定义"值是否变化"的判断。默认 Object.is。返回 true 表示视为未变,跳过通知。 */
  equals?: EqualityFn<T>;
  /**
   * 订阅者数量跨 0 ↔ 1 边沿时调用:`onSubscribersChange(1)`(0→1)、
   * `onSubscribersChange(0)`(1→0)。供 auto-disposable memo 等场景使用。
   */
  onSubscribersChange?: (count: 0 | 1) => void;
}

export function createSignal<T>(
  initialValue: T,
  options?: CreateSignalOptions<T>,
): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  const equals = options?.equals ?? Object.is;
  const onChange = options?.onSubscribersChange;
  let value = initialValue;
  const deps: DepSet = {
    subs: new Set<Schedule>(),
    lastAccessedBy: -1,
    onConnect: onChange ? () => onChange(1) : undefined,
    onDisconnect: onChange ? () => onChange(0) : undefined,
  };

  const read = (): T => {
    const reaction = getCurrentReaction();
    if (reaction) subscribeDep(reaction, deps);

    return value;
  };

  const write = (nextValue: SetValueType<T>) => {
    const newValue = runWithoutTracking(() => (isFn(nextValue) ? nextValue(value) : nextValue));

    if (equals(newValue, value)) return;

    value = newValue;

    for (const reaction of deps.subs) {
      enqueueReaction(reaction);
    }
  };

  return [read, write];
}

export function createReaction() {
  let scheduleUpdate: (() => void | unknown) = noop;

  const reaction: Schedule = {
    schedule: () => scheduleUpdate(),
    dependencies: [],
    newDependencies: null,
    runId: 0,
    inPending: false,
    disposed: false,
  };

  function track<R>(fn: () => R): R {
    if (reaction.disposed) {
      return fn();
    }

    // diff-based + 版本号:每次 track 拿到一个新的 runId,
    // subscribeDep 用它 O(1) 去重,track 结束时 oldDeps 中 lastAccessedBy !== runId 的被移除
    const prevNewDeps = reaction.newDependencies;
    const prevCurrent = currentReaction;
    const collected: DepSet[] = [];
    reaction.newDependencies = collected;
    reaction.runId = nextRunId();
    currentReaction = reaction;

    try {
      return fn();
    } finally {
      currentReaction = prevCurrent;
      reaction.newDependencies = prevNewDeps;

      // 仅移除上轮存在、本轮未被 subscribeDep 标记的依赖;稳定依赖路径下零 Set 写入
      const oldDeps = reaction.dependencies;
      const currentRunId = reaction.runId;
      for (const old of oldDeps) {
        if (old.lastAccessedBy !== currentRunId) {
          old.subs.delete(reaction);
          if (old.subs.size === 0 && old.onDisconnect) {
            old.onDisconnect();
          }
        }
      }
      reaction.dependencies = collected;
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
    // 不主动从 pendingReactions 移除:flushReactions 中 disposed 检查会跳过,
    // 避免 Array.splice 的 O(n) 成本
    cleanup(reaction);
  }

  return { track, reconcile, reaction, dispose };
}

export interface CreateMemoOptions<T> {
  /** 自定义"派生值是否变化"的判断;变化才通知下游订阅者。默认 Object.is。 */
  equals?: EqualityFn<T>;
  /**
   * true 时,依赖变化只把 memo 标记为 dirty,直到下一次 read 才重算。
   * 适用:重算昂贵且未必被立即消费的派生值。
   * 默认 false(eager):依赖变化即在 scheduler 下个 tick 重算并通知下游。
   *
   * 注意:lazy=true 时,如果下游 reaction 已订阅 memo 的 cache signal,
   * dirty 标记不会主动通知下游 —— 下游需要在下次 render 时读取才会看到新值。
   */
  lazy?: boolean;
  /**
   * true 时,无下游订阅者时 memo 自动断开对 deps 的订阅;
   * 第一个订阅者到来时自动重建并立即 recompute 一次。
   * 等价于 MobX `computed` 的 auto-dispose 行为。
   * 默认 false:无论有无订阅者都持续追踪 deps(更省心,不会"陈旧缓存直到下次订阅")。
   */
  autoDispose?: boolean;
}

/**
 * 派生 read 函数,带 .dispose 方法用于释放内部 reaction。
 */
export interface MemoReader<T> {
  (): T;
  dispose(): void;
}

/**
 * 创建一个派生 signal:compute 中读取的信号成为依赖,任一变化时自动重算并通知下游。
 * 通过内部 cache signal 把结果暴露出来,equalityFn 命中时跳过下游通知。
 *
 * - **eager**(默认):依赖变化会在 scheduler 下一个 tick 自动 recompute
 * - **lazy**(`{ lazy: true }`):依赖变化只标 dirty,下次外部 read 才重算
 * - **autoDispose**(`{ autoDispose: true }`):无下游订阅者时自动断开 deps,有订阅者时自动接回
 * - **lazy init**:首次外部 read 才初始化,从未被读则不计算
 * - **dispose**:不再使用时显式调用,断开对依赖的订阅,避免内存泄漏
 *
 * @example
 * const fullName = createMemo(() => `${first()} ${last()}`);
 * useReaction(fullName);   // 在 React 中订阅
 * fullName.dispose();      // 模块卸载或不再需要时调用
 *
 * @example lazy 模式 —— 推迟昂贵计算到真正消费时
 * const sorted = createMemo(() => bigList().slice().sort(), { lazy: true });
 *
 * @example autoDispose 模式 —— 模块级 memo,无人订阅时自动解 deps
 * const filtered = createMemo(() => items().filter(matches), { autoDispose: true });
 */
export function createMemo<T>(
  compute: () => T,
  options?: CreateMemoOptions<T>,
): MemoReader<T> {
  const equals = options?.equals ?? Object.is;
  const lazy = options?.lazy === true;
  const autoDispose = options?.autoDispose === true;

  // cache 初始为 undefined(类型 cast);lazy 模式"未读不计算"语义由此保证
  let reactionInstance: ReturnType<typeof createReaction> | null = null;
  let isDirty = true; // 首次 read 必算一次
  let initialized = false;
  let hasObservers = false;

  const ensureReaction = () => {
    if (reactionInstance) return;
    reactionInstance = createReaction();
    reactionInstance.reconcile(
      lazy
        ? () => {
            isDirty = true;
          }
        : () => {
            recompute();
          },
    );
  };

  const recompute = () => {
    if (reactionInstance) {
      const next = reactionInstance.track(compute);
      writeCache(next);
    } else {
      // autoDispose 且无 observer:untracked 算一次
      const next = untracked(compute);
      writeCache(next);
    }
    isDirty = false;
  };

  const [readCache, writeCache] = createSignal<T>(undefined as unknown as T, {
    equals,
    onSubscribersChange: autoDispose
      ? (count) => {
          if (count === 1 && !hasObservers) {
            // 第一个订阅者到来:接入 deps
            hasObservers = true;
            ensureReaction();
            isDirty = true;
            // 立即 recompute 一次,让 cache 是 fresh deps(否则下游拿到 disconnect 前的 stale 值)
            recompute();
          } else if (count === 0 && hasObservers) {
            // 最后一个订阅者离开:断开 deps
            hasObservers = false;
            reactionInstance?.dispose();
            reactionInstance = null;
            isDirty = true; // 下次 read 走 untracked 路径重算
          }
        }
      : undefined,
  });

  if (!autoDispose) {
    ensureReaction();
  }

  const memoReader = (() => {
    if (!initialized) {
      initialized = true;
    }
    if (isDirty) {
      recompute();
    }
    return readCache();
  }) as MemoReader<T>;

  memoReader.dispose = () => {
    if (reactionInstance) {
      reactionInstance.dispose();
      reactionInstance = null;
    }
    hasObservers = false;
  };

  return memoReader;
}

/**
 * 立即运行 effect,并在其内部读取的信号变化时自动重新运行。
 * 返回 dispose 函数,调用后停止响应。等价于 MobX 的 `autorun`。
 *
 * @example
 * const dispose = autorun(() => {
 *   document.title = `${count()} unread`;
 * });
 * dispose();
 */
export function autorun(effect: () => void): () => void {
  const { track, reconcile, dispose } = createReaction();
  const run = () => {
    track(effect);
  };
  reconcile(run);
  run(); // 立即跑一次:建立依赖 + 执行副作用
  return dispose;
}

export interface ReactionOptions<T> {
  /** 自定义"deps 是否变化"的判断,变化才调用 effect。默认 Object.is。 */
  equals?: EqualityFn<T>;
  /** true 时初始化就调用一次 effect(previous 为 undefined);默认 false,仅建立依赖。 */
  fireImmediately?: boolean;
  /**
   * 大于 0 时,deps 变化后等待 N ms 才执行 effect;
   * 期间任意一次新变化都会重置计时(debounce 语义)。
   * 0 / undefined 表示无延迟,在 scheduler 当前 tick 完成时立即执行。
   */
  delay?: number;
}

/**
 * 当 deps 函数返回值变化时调用 effect(current, previous)。
 * deps 内的信号被追踪;effect 在 untracked 上下文中运行,不会引入依赖。
 * 返回 dispose 函数。等价于 MobX 的 `reaction`。
 *
 * @example
 * const dispose = reaction(
 *   () => user().id,
 *   (id, prevId) => fetchProfile(id),
 *   { delay: 200 },          // 200ms debounce
 * );
 */
export function reaction<T>(
  deps: () => T,
  effect: (current: T, previous: T | undefined) => void,
  options?: ReactionOptions<T>,
): () => void {
  const equals = options?.equals ?? Object.is;
  const fireImmediately = options?.fireImmediately === true;
  const delay = options?.delay ?? 0;
  const { track, reconcile, dispose: disposeReaction } = createReaction();

  let prev: T | undefined;
  let hasRun = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const invokeEffect = (current: T, old: T | undefined) => {
    untracked(() => effect(current, old));
  };

  const run = (callEffect: boolean) => {
    const current = track(deps);
    const skip = hasRun && equals(current, prev as T);
    const old = prev;
    prev = current;
    hasRun = true;
    if (!callEffect || skip) return;

    if (delay > 0) {
      // debounce:取消上次 pending 的 effect,重新计时
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        invokeEffect(current, old);
      }, delay);
    } else {
      invokeEffect(current, old);
    }
  };

  reconcile(() => run(true));
  // 首次:必须 track 一遍才能建立依赖;effect 是否调用看 fireImmediately
  run(fireImmediately);

  return () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    disposeReaction();
  };
}

type ReactionInstance = ReturnType<typeof createReaction>;

interface SnapshotCache<S> {
  hasValue: boolean;
  value: S;
}

export function useReaction<T, S = T>(
  fn: Extract<T>,
  selector: Selector<T, S> = identitySelector as Selector<T, S>,
  equalityFn: EqualityFn<S> = Object.is,
): S {
  // 持久化 reaction 实例(懒初始化,StrictMode 双 mount/remount 安全)
  const reactionRef = useRef<ReactionInstance | null>(null);
  if (reactionRef.current === null) {
    reactionRef.current = createReaction();
  }
  const { track, reconcile, reaction } = reactionRef.current;

  // commit-phase 同步的快照缓存:渲染中只读,useEffect 中写
  // 用于跨 selector / fn 变化时复用上一次提交的引用,保持下游 memo 不被破坏
  const instRef = useRef<SnapshotCache<S> | null>(null);
  if (instRef.current === null) {
    instRef.current = { hasValue: false, value: undefined as unknown as S };
  }
  const inst = instRef.current;

  // stable subscribe:reaction 引用跨渲染稳定,React 不会反复 resubscribe
  const subscribe = useCallback(
    (cb: () => void) => {
      reconcile(cb);
      return () => {
        reconcile(noop);
        // 不从 pendingReactions 删除:flushReactions 会在 schedule=noop 时无害跳过
        cleanup(reaction);
      };
    },
    [reaction, reconcile],
  );

  // 当 fn / selector / equalityFn 变化时重建 memoized getSnapshot
  // 闭包内 memoizedSelection 而非 ref,concurrent 渲染中每个 memo 周期独立、互不干扰
  const getSnapshot = useMemo(() => {
    let memoizedSelection: S;
    let hasMemo = false;

    return () => {
      const next = track(() => selector(fn()));

      if (!hasMemo) {
        hasMemo = true;
        // 首次调用:若上次 commit 的值与本次相等,复用其引用(保留下游 memoization)
        if (inst.hasValue && equalityFn(inst.value, next)) {
          memoizedSelection = inst.value;
          return inst.value;
        }
        memoizedSelection = next;
        return next;
      }

      // 后续调用:相等返回上次引用,不等则更新
      if (equalityFn(memoizedSelection, next)) {
        return memoizedSelection;
      }
      memoizedSelection = next;
      return next;
    };
  }, [fn, selector, equalityFn, track, inst]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // commit phase 同步 inst —— 渲染期间从不修改 ref.current 内部字段
  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [value, inst]);

  return value;
}

export function useSignal<T>(initialValue: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
  const signalRef = useRef<[Extract<T>, SetterOrUpdater<SetValueType<T>>] | null>(null);
  if (signalRef.current === null) {
    signalRef.current = createSignal<T>(initialValue);
  }
  return signalRef.current;
}

/**
 * 在回调中读取信号但不收集依赖。等价于 MobX 的 `untracked`。
 */
export function untracked<T>(fn: () => T): T {
  return runWithoutTracking(fn);
}

/**
 * 包装一个 selector：当其输出与上次结果浅相等时,返回上次的引用。
 * 用于让 inline 对象/数组 selector 不再每次渲染都触发 re-render。
 *
 * 实现细节:用 useMemo 持有 closure 而非 useRef,
 * closure 内的 prev/hasPrev mutate 是 useMemo-local state,
 * 不属于 React 视图中的"渲染期间副作用",符合 React 19 / React Compiler 规范。
 *
 * @example
 * const { a, b } = useStore(useShallow((s) => ({ a: s.a, b: s.b })));
 */
export function useShallow<T, S>(selector: Selector<T, S>): Selector<T, S> {
  return useMemo(() => {
    let prev: S;
    let hasPrev = false;
    return (state: T) => {
      const next = selector(state);
      if (hasPrev && shallow(prev, next)) return prev;
      prev = next;
      hasPrev = true;
      return next;
    };
  }, [selector]);
}

export function create<T extends object>(initState: T) {
  const [state, setState] = createSignal<T>(initState);
  // 跟踪外部(非 React)订阅,以便 dispose 时一并解除
  const externalDisposers = new Set<() => void>();
  let disposed = false;

  const useStore = <S = T>(selector?: Selector<T, S>, equalityFn?: EqualityFn<S>) =>
    useReaction(state, selector, equalityFn);

  const dispatch = (updater: StoreUpdater<T>) => {
    if (disposed) return;

    if (isFn(updater)) {
      const nextState = produce(state(), updater as Producer<T>);
      setState(nextState as T);
      return;
    }

    setState((prevState) => ({ ...prevState, ...updater }));
  };

  // 外部 subscribe 的两种形态:
  //   subscribe(listener): 监听全量 state,listener 接 (current, previous)
  //   subscribe(selector, listener, options?): 只在 selector 输出变化时触发,
  //     listener 接 (sliceCurrent, slicePrev);支持 equalityFn / fireImmediately
  type FullListener = (current: T, previous: T) => void;
  type SelectListener<S> = (slice: S, previous: S) => void;
  type SubscribeOptions<S> = ReactionOptions<S> & { equalityFn?: EqualityFn<S> };

  const subscribeFull = (listener: FullListener): (() => void) => {
    if (disposed) return noop;

    let prev = untracked(state);
    const stop = reaction(
      () => state(),
      (current, previous) => {
        listener(current, (previous ?? prev) as T);
        prev = current;
      },
    );
    externalDisposers.add(stop);

    return () => {
      stop();
      externalDisposers.delete(stop);
    };
  };

  const subscribeWithSelector = <S>(
    selector: Selector<T, S>,
    listener: SelectListener<S>,
    options?: SubscribeOptions<S>,
  ): (() => void) => {
    if (disposed) return noop;

    // 优先用 options.equalityFn,其次 ReactionOptions 内嵌 equals 字段
    const equals = options?.equalityFn ?? options?.equals ?? Object.is;
    const fireImmediately = options?.fireImmediately === true;

    const stop = reaction(
      // deps 内调用 state() 必须跑在 track 上下文,才能建立订阅
      () => selector(state()),
      (current, previous) => listener(current, previous as S),
      { equals, fireImmediately },
    );
    externalDisposers.add(stop);

    return () => {
      stop();
      externalDisposers.delete(stop);
    };
  };

  /**
   * 订阅 store 变化。
   * - 形式 1:`subscribe(listener)`,listener 签名 `(current, previous) => void`
   * - 形式 2:`subscribe(selector, listener, { equalityFn?, fireImmediately? })`,
   *   仅在 selector 输出变化时触发,支持 `equalityFn` 自定义相等、
   *   `fireImmediately: true` 立即触发一次。
   */
  function subscribe(
    listener: FullListener,
  ): () => void;
  function subscribe<S>(
    selector: Selector<T, S>,
    listener: SelectListener<S>,
    options?: SubscribeOptions<S>,
  ): () => void;
  function subscribe<S>(
    listenerOrSelector: FullListener | Selector<T, S>,
    maybeListener?: SelectListener<S>,
    options?: SubscribeOptions<S>,
  ): () => void {
    if (disposed) return noop;
    if (typeof maybeListener === "function") {
      return subscribeWithSelector(
        listenerOrSelector as Selector<T, S>,
        maybeListener,
        options,
      );
    }
    return subscribeFull(listenerOrSelector as FullListener);
  }

  /**
   * 释放 store:dispatch 变 noop,外部 subscribe 全部解除。
   * React 组件不会被强制 unmount,但因 dispatch 不再生效,显示的 snapshot 将冻结。
   * 幂等。
   */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const disposeReaction of externalDisposers) {
      disposeReaction();
    }
    externalDisposers.clear();
  };

  return { useStore, dispatch, getState: state, subscribe, dispose };
}
