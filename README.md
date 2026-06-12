<p align="center">
  <img src="maizi.png" />
</p>

为 React 18 / 19 设计的小而快的响应式层 —— signals + reactions + Zustand 风格 store,产物小于 4 KB。

[English](./README.en.md)

```bash
npm install @frada/tally   # 或 yarn / pnpm add @frada/tally
```

---

## 快速开始:Zustand 风格的 store

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

无需 Provider。组件只在所选切片变化时 re-render。

---

## API 参考

### `create<T>(initState)`

返回一个 store,成员如下:

| 成员 | 签名 | 说明 |
|---|---|---|
| `useStore` | `<S>(selector?, equalityFn?) => S` | React hook。选取切片。默认 `Object.is`。 |
| `dispatch` | `(partial \| producer) => void` | 对象 → 浅合并;函数 → Immer producer(改 `draft`)。 |
| `getState` | `() => T` | React 外读取当前状态,不订阅。 |
| `subscribe` | `(listener) => unsubscribe` | React 外订阅。每次变化都拿到最新 state。 |
| `dispose` | `() => void` | 永久禁用 store。`dispatch` 变 no-op;外部订阅者全部解除。幂等。 |

```jsx
// selector + 自定义相等(浅等时不 re-render)
import { shallow } from '@frada/tally'
const { name, age } = useStore((s) => ({ name: s.name, age: s.age }), shallow)

// 外部订阅
const unsub = bearStore.subscribe((state) => console.log('changed', state))
unsub()

// 一次性读取
const snapshot = bearStore.getState()

// 动态创建的 store 卸载时清理
bearStore.dispose()
```

---

### `useShallow(selector)`

包装 selector,使浅等的输出复用上次的引用。inline 对象 selector(否则每次都 re-render)最干净的修复。

```jsx
import { useShallow } from '@frada/tally'

const { a, b } = useStore(useShallow((s) => ({ a: s.a, b: s.b })))
```

大多数场景等价于 `useStore(selector, shallow)`,而且引用跨渲染稳定。

---

### `createSignal<T>(initialValue, options?)`

响应式原子。返回 `[read, write]`。

```ts
import { createSignal, shallow } from '@frada/tally'

const [count, setCount] = createSignal(0)
count()                  // 0
setCount(1)              // 1
setCount((prev) => prev + 1)

// 自定义相等 —— 仅在浅不等时通知订阅者
const [points, setPoints] = createSignal([1, 2, 3], { equals: shallow })
setPoints([1, 2, 3])     // 不通知 —— shallow-equal
```

### `useSignal<T>(initialValue)`

组件本地 signal(与 `useState` 同形,但返回 signal 对)。

```jsx
function Counter() {
  const [count, setCount] = useSignal(0)
  return <button onClick={() => setCount(count() + 1)}>{count()}</button>
}
```

### `useReaction<T, S>(fn, selector?, equalityFn?)`

比 `useStore` 更底层 —— 订阅任意"读 signal 的函数"。

```jsx
const value = useReaction(myMemo)                                    // 订阅一个 memo
const slice = useReaction(myStore, (s) => s.list, shallow)          // selector + 相等函数
```

内部细节:
- `getSnapshot` 只在 `fn / selector / equalityFn` 变化时重建(React 19 concurrent-safe)
- `subscribe` 稳定 —— 跨渲染不重订阅
- selector 切换时,若 `equalityFn` 命中则保留上次引用,下游 `useMemo` / `React.memo` 链不会被打破

---

### `createMemo<T>(compute, options?)`

派生 signal。追踪 `compute` 内读到的所有 signal;依赖变化时重算;`equals` 命中时不通知下游。

```jsx
import { createSignal, createMemo, useReaction } from '@frada/tally'

const [first, setFirst] = createSignal('Ada')
const [last,  setLast]  = createSignal('Lovelace')

const fullName = createMemo(() => `${first()} ${last()}`)

function NameTag() {
  const name = useReaction(fullName)
  return <span>{name}</span>
}

// 模块级 memo 不再使用时应 dispose
fullName.dispose()
```

- **lazy init**:首次有人读 memo 时才跑 `compute`
- **eager 重算**:首次 read 后,依赖变化在下一个 scheduler tick 自动重算
- **equality 短路**:重算结果与上次 `equals` 命中时,下游订阅者不会被通知

---

### `createReaction()` —— 低层原语

`useReaction` 与 `createMemo` 背后的构建块。大多数用户不需要直接用。

```ts
const { track, reconcile, dispose } = createReaction()
reconcile(() => console.log('deps changed'))
track(() => { count(); name() })     // 建立依赖集合
dispose()
```

| 成员 | 说明 |
|---|---|
| `track(fn)` | 在 reaction 的追踪上下文中运行 `fn`。diff-based:只有"消失"的依赖会被解除订阅。 |
| `reconcile(fn)` | 设置下次依赖变化后 scheduler flush 时调用的回调。 |
| `dispose()` | 永久禁用。幂等。 |

---

### `untracked(fn)`

读 signal **但不订阅**。

```ts
import { untracked } from '@frada/tally'

const snapshotOnly = untracked(() => count())   // 不建立依赖
```

---

### `autorun(effect)` 与 `reaction(deps, effect, options?)`

MobX 风格的副作用 API。两者都返回 `dispose` 函数。

```ts
import { autorun, reaction, createSignal } from '@frada/tally'

const [count, setCount] = createSignal(0)

// autorun:立即跑一次,后续任意 signal 变化都重跑
const stop1 = autorun(() => {
  document.title = `${count()} unread`
})

// reaction:仅 deps() 返回值变化才跑 effect
const stop2 = reaction(
  () => count(),
  (current, previous) => console.log(`从 ${previous} 变成 ${current}`),
  { equals: Object.is, fireImmediately: false, delay: 0 }, // 全部为默认
)

stop1()
stop2()
```

| API | `effect` 何时跑 | 追踪范围 |
|---|---|---|
| `autorun(effect)` | 立即 + 每次依赖变化 | `effect` 内所有 signal 都是 deps |
| `reaction(deps, effect, opts?)` | 仅 `deps()` 返回新值时 | 只追踪 `deps` 内的 signal;`effect` 在 untracked 上下文运行 |

**`reaction` 的 `delay` 选项**(debounce 语义):

```ts
// dep 变化后等 200ms 才跑 effect;期间又变化重置计时
const stop = reaction(
  () => query(),
  (q) => fetch(`/search?q=${q}`),
  { delay: 200 },
)
```

---

### `configureScheduler(type)`

全局切换批处理调度引擎。应用启动时调用一次。

```ts
import { configureScheduler } from '@frada/tally'

configureScheduler('channel')    // 默认 —— MessageChannel(宏任务,适合高频写入)
configureScheduler('promise')    // Promise.resolve().then(微任务,响应最快)
configureScheduler('microtask')  // queueMicrotask
```

### `setErrorHandler(handler)`

抛错的 reaction 被隔离(不影响队列其他 reaction)。默认行为是异步重抛,让宿主的 unhandled-error handler 捕获。生产环境推荐注入自定义 handler,转发到 Sentry / 监控平台。

```ts
import { setErrorHandler } from '@frada/tally'

setErrorHandler((err) => Sentry.captureException(err))
setErrorHandler(null) // 恢复默认
```

### `shallow(a, b)`

浅相等 helper,支持对象、数组、Map、Set。作为 `equalityFn` 使用:

```ts
useStore((s) => ({ a: s.a, b: s.b }), shallow)
```

---

## 设计要点

- **Concurrent-safe**:`useReaction` 用 lazy `useRef` 初始化 + commit-phase `useEffect` 同步,React 19 strict-mode 双 mount 与 selector 切换都能保持引用稳定。
- **批处理调度**:同一 tick 内的多次写入合并;默认 flush 走 `MessageChannel`(宏任务),避免阻塞输入处理。
- **Diff-based 依赖追踪**:每次 `track` 周期拿到一个新的 `runId`。`subscribeDep` 用 `runId` 在 O(1) 内 dedup;`track` 的 finally 只移除"本次未出现"的旧依赖。**稳定依赖路径下零 `Set` 写入。**
- **错误隔离**:单个抛错的 reaction 经 `errorHandler` 上报,绝不污染队列其余 reaction。

---

## 工程

```bash
pnpm test       # 跑全部测试(44 个)
pnpm bench      # 跑微基准
pnpm build      # 构建到 dist/(CJS + ESM + d.ts)
pnpm lint       # eslint
```

参见 [CHANGELOG.md](./CHANGELOG.md) 了解版本历史。

---

### 为什么用 @frada/tally 而不是 redux?

- hook 是消费状态的主要方式 —— 不用 `connect`,无样板代码
- 不需要把整个 app 包在 context provider 里
- 压缩后 < 4 KB

### 为什么用 @frada/tally 而不是裸 context?

- **只**重新渲染所选切片变化了的组件
- 自带 `subscribe`,可在 React 之外使用
- 内置 `createMemo` 派生状态
