# Changelog

All notable changes to `@frada/tally` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [2.0.0] — Major refactor: concurrent-safe, diff-based, batteries included

This release is a comprehensive overhaul: same core API for `create()` users, dramatically faster internals, full React 18 / 19 concurrent compliance, and a much larger surface for advanced users.

The only **breaking** change is in `@internal` types (`Schedule`, `DepSet`). The public `create()` / `useStore()` / `dispatch()` contract is unchanged.

### Added

#### New primitives

- **`createMemo<T>(compute, { equals? })`** — derived signal with lazy init, eager recompute on dep change, equality short-circuit, and explicit `dispose()`.
- **`createSignal<T>(value, { equals? })`** — `equals` option to replace hard-coded `Object.is`.

#### New side-effect APIs (MobX-style)

- **`autorun(effect)`** — runs immediately, re-runs on any dep change. Returns `dispose`.
- **`reaction(deps, effect, { equals?, fireImmediately? })`** — runs `effect(current, previous)` only when `deps()` value changes. Effect runs in `untracked` context.

#### React integration

- **`useReaction(fn, selector?, equalityFn?)`** — third argument `equalityFn` (defaults to `Object.is`).
- **`useShallow(selector)`** — wraps an inline selector so identical shallow-equal outputs reuse the previous reference; `useMemo` + closure implementation (React 19 / Compiler friendly).

#### Store factory

- **`create().subscribe(listener)`** — external (non-React) subscription; returns unsubscribe.
- **`create().dispose()`** — permanently disable a store. `dispatch` becomes a no-op; all external subscribers are unsubscribed. Idempotent.

#### Globals

- **`configureScheduler(type: 'channel' | 'promise' | 'microtask')`** — switch batching engine at app startup. Default unchanged (`channel`).
- **`setErrorHandler(handler | null)`** — inject a handler for errors thrown by a reaction; default re-throws via `queueMicrotask` for the host's unhandled-error handler.
- **`untracked(fn)`** — public name for "read signals without subscribing".

#### Types

- `EqualityFn<S>`, `CreateSignalOptions<T>`, `CreateMemoOptions<T>`, `ReactionOptions<T>`, `MemoReader<T>`, `SchedulerType` are now exported.

#### Tooling

- **`pnpm test`** / **`pnpm test:watch`** — first test suite (29 cases) covering `createSignal`, `createReaction`, `createMemo`, `untracked`, `configureScheduler`, error isolation, batching, `autorun`, `reaction`.
- **`pnpm bench`** — self-contained micro-benchmarks for write fan-out, stable-deps track, memo recompute / short-circuit.

### Changed (performance)

- **Diff-based dependency tracking**: `track()` no longer calls `cleanup()` upfront. Each track run gets a fresh `runId`; `subscribeDep` dedupes via `DepSet.lastAccessedBy === runId` in O(1); `track`'s finally only removes deps that disappeared this run. **Stable-deps path incurs zero `Set` writes.**
- **`pendingReactions: Schedule[]`** (was `Set<Schedule>`) + `Schedule.inPending: boolean` flag for O(1) dedup. `Array.from(Set)` snapshot replaced with `Array.slice`.
- **`runWithoutTracking`**: O(n) stack splice/restore → O(1) `trackingSuspended` counter.
- **`reactionStack: Schedule[]`** → `let currentReaction: Schedule | null` with `prev/restore` in `track`; no more Array `push`/`pop`.
- **`createSignal.write`**: no more `Array.from(subscriptions)` defensive copy; iterates the Set directly.
- **`useReaction.getSnapshot`**: per-reaction `isDirty` instead of a global `globalVersion`. Unrelated signal writes no longer force every subscribed component to re-run its selector.
- **`useReaction`**: `useState(() => createSignal(...))` → `useRef + lazy init` in `useSignal` and store memoization; one fewer fiber state slot.

### Changed (concurrent safety)

- **`useReaction` was rewritten** to follow React's `useSyncExternalStoreWithSelector` model:
  - Reaction instance held in `useRef` with lazy init; safe across StrictMode double-mount.
  - `getSnapshot` rebuilt only when `fn / selector / equalityFn` change, with a memoized closure for stable references.
  - Subscribe is stable via `useCallback`.
  - `instRef + useEffect` synchronizes the committed value, so selector switches that satisfy `equalityFn` reuse the previously-committed reference and don't break downstream `React.memo`.
- **`flushReactions`** isolates a single throwing reaction; the rest of the queue still runs. Error goes through `errorHandler` (configurable).
- **`subscribe` cleanup in `useReaction`** resets `reconcile(noop)` so a unmounted reaction can be safely re-subscribed by a future StrictMode remount.
- **`useShallow`** moved from `useRef + render-phase write` to `useMemo + closure`; closure-local mutation is hook-internal state, transparent to React Compiler.

### Changed (types & code quality)

- `isFn` type guard: `Function` → `(...args: never[]) => unknown`; `eslint-disable` removed.
- `Schedule` / `DepSet` marked `@internal`. `DepSet` is now an `interface { subs: Set<Schedule>; lastAccessedBy: number }` (was `type DepSet = Set<Schedule>`).
- `Schedule` gained `newDependencies`, `runId`, `inPending` fields; `dependencies` is now `DepSet[]` (was `Set<DepSet>`).
- `runIdCounter` wraps `nextRunId()` helper with `Number.MAX_SAFE_INTEGER` guard (throws rather than silently wrap).
- `Producer<T>` import path validated against both `immer@9` and `@11`.

### Breaking changes

These only affect users who reached into `@internal` types:

- **`DepSet`** is now `interface { subs: Set<Schedule>; lastAccessedBy: number }`, not `Set<Schedule>`. If you destructured it, replace `dep` with `dep.subs`.
- **`Schedule`** gained three new fields. Code that constructs `Schedule` objects directly must initialize them.

The public surface (`create`, `useStore`, `dispatch`, `getState`, `useSignal`, `createSignal`, `createReaction`, `isFn`, `shallow`) is unchanged.

### Benchmarks (Apple Silicon, node 22.19)

```
silent write (no subscribers)              ~27 M ops/s
createSignal() allocation                  ~32 M ops/s
createReaction() allocation                ~20 M ops/s
write fan-out → 10  reactions               ~4 M ops/s
write fan-out → 100 reactions               ~6 M ops/s
write fan-out → 1000 reactions             ~714 k ops/s
track re-run, 10  stable deps              ~7 M ops/s
track re-run, 100 stable deps              ~970 k ops/s
track re-run, 1000 stable deps              ~90 k ops/s
memo recompute on dep change               ~20 M ops/s
memo short-circuit (result unchanged)      ~30 M ops/s
```

`stable-deps track` is the headline: 1000 deps re-tracked at ~90k ops/s confirms the diff-based path does ~zero `Set` writes per call.

---

## [1.2.12] and earlier

Initial Zustand-style store API: `create`, `useStore`, `dispatch`, `getState`. See git log for incremental changes prior to 2.0.0.
