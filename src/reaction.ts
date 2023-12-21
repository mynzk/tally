import {useState, useSyncExternalStore, useMemo} from "react";
export interface Schedule {
    schedule: () => () => unknown | void;
    dependencies: Set<Set<Schedule>>;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export const isFn = (x: any): x is Function => typeof x === "function";
export type SetValueType<S> = S | ((prevValue: S) => S);
export type SetterOrUpdater<T> = (value: T) => void;
type ExtractState<S> = S extends () => infer T ? T: never;
type Extract<S> = () => S;

const context: any[] = [];

function subscribe(schedule: Schedule, subscriptions: Set<Schedule>) {
    subscriptions.add(schedule);
    schedule.dependencies.add(subscriptions);
}

export function createSignal<T>(value: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
    const subscriptions = new Set<Schedule>();

    const read = (): T => {
        const schedule = context[context.length - 1];
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

type ReturnReaction = ReturnType<typeof createReaction>;

export function useReaction<T>(fn: Extract<T>):T;

export function useReaction<T, S>(fn: Extract<T>, selector?: (state: ExtractState<Extract<T>>) => S): S;

export function useReaction<T, S>(fn: Extract<T>, selector = (state: ExtractState<Extract<T>>) => state as any) {
    const {subscribe, track} = useMemo(() => {
        let scheduleUpdate: null | (() => void) = null;
        const subscribe = (cb: () => void) => {
            scheduleUpdate = cb;
            return () => {
                scheduleUpdate = null;
            }
        }
        const {track, reconcile}: ReturnReaction = createReaction();
        reconcile(() => scheduleUpdate?.());
        return {subscribe, track};
    }, []);

    const getState: Extract<S> = () => selector(fn());

    const state = useSyncExternalStore(subscribe, getState, getState)

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

export function useSignal<T>(signal: T): [Extract<T>, SetterOrUpdater<SetValueType<T>>] {
    const [[read, write]] = useState(() => createSignal<T>(signal));
    return [read, write];
}

export function create<T>(initState: T) {
    const [state, setState] = createSignal<T>(initState);
    const useStore = <S>(selector?: (state: ExtractState<Extract<T>>) => S) => useReaction(state, selector);

    const dispatch = (nextState: Partial<T> | ((oldState: T) => Partial<T>)) => {
        const newState = isFn(nextState) ? nextState(state()) : nextState;
        setState(s => Object.assign({}, s, newState))
    }

    return {useStore, dispatch};
}
