<p align="center">
  <img src="maizi.png" />
</p>

A small, fast reactivity layer for React 18 / 19 — signals + reactions + a Zustand-style store, in <4 KB.

[中文文档](./README.md)

```bash
npm install @frada/tally   # or yarn / pnpm add @frada/tally
```

---

## Quick start: a Zustand-style store

```jsx
import { create } from '@frada/tally'

const bearStore = create({ bears: 0 })

const { useStore, dispatch, getState, subscribe, dispose } = bearStore

export const increasePopulation = () => dispatch((state) => ({ bears: state.bears + 1 }))
export const removeAllBears     = () => dispatch({ bears: 0 })

export const useBearStore = useStore
export const bearDispatch = dispatch
```

```jsx
function BearCounter() {
  const bears = useBearStore((state) => state.bears)
  return <h1>{bears} around here ...</h1>
}

function Controls() {
  return (
    <div>
      <button onClick={increasePopulation}>one up</button>
      <button onClick={removeAllBears}>remove all</button>
    </div>
  )
}
```

No providers needed. Components re-render only when their selected slice changes.

---

## API reference

### `create<T>(initState)`

Returns a store with the following members:

| Member | Signature | Notes |
|---|---|---|
| `useStore` | `<S>(selector?, equalityFn?) => S` | React hook. Selects a slice. Defaults to `Object.is`. |
| `dispatch` | `(partial \| producer) => void` | Object → shallow merge. Function → Immer producer (mutate `draft`). |
| `getState` | `() => T` | Read current state outside React, no subscription. |
| `subscribe` | `(listener) => unsubscribe` | Subscribe outside React. Listener gets the latest state on every change. |
| `dispose` | `() => void` | Permanently disable the store. `dispatch` becomes a no-op; external subscribers are unsubscribed. Idempotent. |

```jsx
// Selector + custom equality (avoids re-render when shallow-equal)
import { shallow } from '@frada/tally'
const { name, age } = useStore((s) => ({ name: s.name, age: s.age }), shallow)

// External subscription
const unsub = bearStore.subscribe((state) => console.log('changed', state))
unsub()

// One-shot read
const snapshot = bearStore.getState()

// Tear down a dynamically-created store
bearStore.dispose()
```

---

### `useShallow(selector)`

Wrap a selector so identical shallow-equal outputs reuse the previous reference. The cleanest fix for inline-object selectors (which would otherwise re-render every time).

```jsx
import { useShallow } from '@frada/tally'

const { a, b } = useStore(useShallow((s) => ({ a: s.a, b: s.b })))
```

Equivalent to `useStore(selector, shallow)` for most cases, with stable reference preserved across renders.

---

### `createSignal<T>(initialValue, options?)`

The atom of reactivity. Returns `[read, write]`.

```ts
import { createSignal, shallow } from '@frada/tally'

const [count, setCount] = createSignal(0)
count()                  // 0
setCount(1)              // 1
setCount((prev) => prev + 1)

// Custom equality — only notify subscribers when shallow-different
const [points, setPoints] = createSignal([1, 2, 3], { equals: shallow })
setPoints([1, 2, 3])     // no notify — shallow-equal
```

### `useSignal<T>(initialValue)`

Component-local signal (same shape as `useState`, but as a signal pair).

```jsx
function Counter() {
  const [count, setCount] = useSignal(0)
  return <button onClick={() => setCount(count() + 1)}>{count()}</button>
}
```

### `useReaction<T, S>(fn, selector?, equalityFn?)`

Lower-level than `useStore` — subscribes to any signal-reading function.

```jsx
const value = useReaction(myMemo)                                    // subscribe a memo
const slice = useReaction(myStore, (s) => s.list, shallow)          // selector + equality
```

Internally:
- `getSnapshot` is rebuilt only when `fn / selector / equalityFn` change (React 19 concurrent-safe).
- `subscribe` is stable — no resubscribe between renders.
- Selector-switch preserves the previous reference if `equalityFn` matches, so downstream `useMemo` / `React.memo` chains stay stable.

---

### `createMemo<T>(compute, options?)`

A derived signal. Tracks every signal read inside `compute`; recomputes when any of them changes; notifies downstream only when the result actually differs (`equals` option, defaults to `Object.is`).

```jsx
import { createSignal, createMemo, useReaction } from '@frada/tally'

const [first, setFirst] = createSignal('Ada')
const [last,  setLast]  = createSignal('Lovelace')

const fullName = createMemo(() => `${first()} ${last()}`)

function NameTag() {
  const name = useReaction(fullName)
  return <span>{name}</span>
}

// Module-level memos should be disposed when no longer used
fullName.dispose()
```

- **Lazy init**: `compute` only runs the first time someone reads the memo.
- **Eager recompute**: after the first read, dependency changes trigger a recompute on the next scheduler tick.
- **Equality short-circuit**: if the new derived value is `equals` to the previous one, downstream subscribers are not notified.

---

### `createReaction()` — low-level primitive

The building block behind `useReaction` and `createMemo`. Most users don't need it.

```ts
const { track, reconcile, dispose } = createReaction()
reconcile(() => console.log('deps changed'))
track(() => { count(); name() })     // build dependency set
dispose()
```

| Member | Notes |
|---|---|
| `track(fn)` | Run `fn` inside the reaction's tracking context. Diff-based: only the deps that disappear get unsubscribed. |
| `reconcile(fn)` | Set the callback fired on the next scheduler flush after deps change. |
| `dispose()` | Permanently disable. Idempotent. |

---

### `untracked(fn)`

Read signals **without** subscribing.

```ts
import { untracked } from '@frada/tally'

const snapshotOnly = untracked(() => count())   // no dep added
```

---

### `autorun(effect)` and `reaction(deps, effect, options?)`

Side-effect APIs in the MobX tradition. Both return a `dispose` function.

```ts
import { autorun, reaction, createSignal } from '@frada/tally'

const [count, setCount] = createSignal(0)

// autorun: runs immediately, re-runs whenever any signal it reads changes
const stop1 = autorun(() => {
  document.title = `${count()} unread`
})

// reaction: only runs `effect` when the value returned by `deps` changes
const stop2 = reaction(
  () => count(),
  (current, previous) => console.log(`went from ${previous} to ${current}`),
  { equals: Object.is, fireImmediately: false }, // both default
)

stop1()
stop2()
```

| API | When `effect` runs | Tracking |
|---|---|---|
| `autorun(effect)` | Immediately + on every dep change | All signals read inside `effect` are deps |
| `reaction(deps, effect, opts?)` | Only when `deps()` returns a new value | Only signals read inside `deps` are deps. `effect` runs untracked. |

---

### `configureScheduler(type)`

Globally switch the batching engine. Call once at app startup.

```ts
import { configureScheduler } from '@frada/tally'

configureScheduler('channel')    // default — MessageChannel (macro-task, best for high-frequency writes)
configureScheduler('promise')    // Promise.resolve().then (micro-task, fastest response)
configureScheduler('microtask')  // queueMicrotask
```

### `setErrorHandler(handler)`

A throwing reaction is isolated (never breaks the rest of the queue). By default, the error is re-thrown asynchronously so the host's unhandled-error handler can see it. Inject a custom handler to forward to Sentry / your monitoring platform.

```ts
import { setErrorHandler } from '@frada/tally'

setErrorHandler((err) => Sentry.captureException(err))
setErrorHandler(null) // restore default
```

---

### `shallow(a, b)`

Shallow-equality helper for objects, arrays, Maps, and Sets. Use as `equalityFn`:

```ts
useStore((s) => ({ a: s.a, b: s.b }), shallow)
```

---

## Design notes

- **Concurrent-safe**: `useReaction` uses lazy `useRef` init + commit-phase `useEffect` sync, so React 19 strict-mode double-mount and selector switches preserve referential stability.
- **Batched scheduling**: writes within the same tick are coalesced; the flush runs on `MessageChannel` (macro-task) by default to avoid blocking input handlers.
- **Diff-based dependency tracking**: each `track` cycle assigns a fresh `runId`. `subscribeDep` dedupes by `runId` in O(1); `track`'s finally only removes deps that **disappeared** this run. Stable dependency paths incur zero `Set` writes.
- **Error isolation**: a single throwing reaction is reported via `queueMicrotask(() => { throw err })` and never poisons the rest of the queue.

---

### Why @frada/tally over redux?

- Hooks are the primary means of consuming state — no `connect`, no boilerplate
- No app-wrapping context provider
- < 4 KB minified + brotli

### Why @frada/tally over plain context?

- Renders **only** the components whose selected slice changed
- Out-of-the-box external `subscribe` for non-React consumers
- Built-in derived state via `createMemo`
