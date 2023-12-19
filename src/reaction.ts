import {useState, useEffect, useRef} from "react";
import {shallow} from "./shallow";
export interface Schedule {
    schedule: () => () => unknown | void;
    dependencies: Set<Set<Schedule>>;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export const isFn = (x: any): x is Function => typeof x === "function";
export type SetValueType<S> = S | ((prevValue: S) => S);
export type SetterOrUpdater<T> = (value: T) => void;
const context: any[] = [];

function subscribe(schedule: Schedule, subscriptions: Set<Schedule>) {
    subscriptions.add(schedule);
    schedule.dependencies.add(subscriptions);
}

export function createSignal<T>(value: T): [() => T, SetterOrUpdater<SetValueType<T>>] {
    const subscriptions = new Set<Schedule>();

    const read = (): T => {
        const schedule = context[context.length - 1];
        console.log(context, "context");
        if (schedule) subscribe(schedule, subscriptions);
        return value;
    };

    const write = (nextValue: SetValueType<T>) => {
        const newValue = isFn(nextValue) ? nextValue(value) : nextValue;
        if (!Object.is(newValue, value)) {
            value = newValue;
            for (const sub of Array.from(subscriptions)) {
                sub.schedule()?.();
            }
        }
    };
    return [read, write];
}

function cleanup(reaction: any) {
    for (const dep of reaction.dependencies) {
        dep.delete(reaction);
    }
    reaction.dependencies.clear();
}

export function createReaction() {
    let schedule!: () => void | unknown;
    const reaction = {
        schedule: () => schedule,
        dependencies: new Set<Set<Schedule>>(),
    };

    function track(fn: () => void) {
        cleanup(reaction);
        context.push(reaction);
        try {
            fn();
        } finally {
            context.pop();
        }
    }

    function reconcile(fn: () => void | unknown) {
        schedule = fn;
    }

    return {track, reconcile};
}

function flush(fn: () => void) {
    if (typeof MessageChannel !== "undefined") {
        const {port1, port2} = new MessageChannel();
        port1.onmessage = fn;
        port2.postMessage(null);
    } else {
        setTimeout(fn);
    }
}

type ReturnReaction = ReturnType<typeof createReaction>;

export function useReaction<T, S>(fn: () => T, selector = (state:T) => state as any): S {
    const [state, setState] = useState<S>(() => selector(fn()));
    const [{track, reconcile}] = useState<ReturnReaction>(() => createReaction());
    const queue = useRef<number>(0);
    const mounted = useRef(false);
    const currentState = useRef<S>(state);
    currentState.current = state;

    useEffect(() => {
        if (mounted.current) return;
        mounted.current = true;
        reconcile(() => {
            queue.current += 1;
            queue.current === 1 &&
            flush(() => {
                queue.current = 0;
                const preState = currentState.current;
                const nextState = selector(fn());
                if (!shallow(preState, nextState)) setState(nextState);
            });
        });
    }, []);

    let exception;
    track(() => {
        try {
            fn();
        } catch (e) {
            exception = e;
        }
    });

    if (exception) {
        throw exception; // re-throw any exceptions caught during rendering
    }

    return state;
}

export function useSignal<T>(signal: T): [() => T, SetterOrUpdater<SetValueType<T>>] {
    const [[read, write]] = useState(() => createSignal<T>(signal));
    return [read, write];
}

export function create<T>(initState: T) {
    const [state, setState] = createSignal<T>(initState);
    const useStore = <S>(selector: (state: T) => S) => useReaction(state, selector);

    const dispatch = (nextState: Partial<T> | ((oldState: T) => Partial<T>)) => {
        const newState = isFn(nextState) ? nextState(state()) : nextState;
        setState(s => Object.assign({}, s, newState))
    }

    return {useStore, dispatch};
}
