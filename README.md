<p align="center">
  <img src="maizi.png" />
</p>

```bash
npm install @frada/tally # or yarn add @frada/tally or pnpm add @frada/tally
```

## First create a store

```jsx
import { create } from '@frada/tally'

const bearStore = create({
    bears: 0,
});

const {useStore, dispatch} = bearStore;

export const increasePopulation = () => {
    dispatch((state) => ({ bears: state.bears + 1 }))
}

export const removeAllBears = () => {
    dispatch({ bears: 0 })
}

export const useBearStore = useStore;
export const bearDispatch = dispatch;
```

## Then bind your components, and that's it!

Use the hook anywhere, no providers are needed. Select your state and the component will re-render on changes.

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

### Why @frada/tally over redux?

- Makes hooks the primary means of consuming state
- Doesn't wrap your app in context providers

### Why @frada/tally over context?

- Less boilerplate
- Renders components only on changes