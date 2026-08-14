import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";

type ParamValue = string | number;

type ParamConfig<T extends Record<string, ParamValue>> = {
  [K in keyof T]: {
    defaultValue: T[K];
    parse: (value: string) => T[K];
    serialize?: (value: T[K]) => string;
  };
};

/**
 * Object.entries() widens keys to `string` and loses value types for mapped
 * generic types like ParamConfig<T> - this restores both, so `key` and the
 * destructured config fields stay properly typed everywhere they're used.
 */
function typedEntries<T extends object>(obj: T): Array<[keyof T, T[keyof T]]> {
  return Object.entries(obj) as Array<[keyof T, T[keyof T]]>;
}

function isValidValue(value: ParamValue): boolean {
  return typeof value !== "number" || !Number.isNaN(value);
}

// Module-level store - survives component unmount/remount within the same
// browser session, wiped on full page reload. Each page gets its own slot
// via storageKey. Subscribers are notified per-key via useSyncExternalStore
// so React re-renders correctly whenever the store changes, without relying
// on a searchParams change happening in the same tick.
const memoryStore: Record<string, Record<string, string>> = {};
const listenersByKey: Record<string, Set<() => void>> = {};

function notify(storageKey: string) {
  listenersByKey[storageKey]?.forEach((listener) => listener());
}

function writeSnapshot(storageKey: string, snapshot: Record<string, string>) {
  memoryStore[storageKey] = snapshot;
  notify(storageKey);
}

function clearSnapshot(storageKey: string) {
  delete memoryStore[storageKey];
  notify(storageKey);
}

/**
 * Syncs typed state to/from URL search params, with in-memory persistence
 * across navigation (survives component unmount/remount, resets on page reload).
 *
 * Priority: URL params > in-memory snapshot > defaultValue
 *
 * IMPORTANT: define `config` outside the component as a module-level const —
 * inline objects will cause unnecessary re-renders.
 *
 * @param storageKey  Unique key per page, e.g. "my-documents"
 * @param config      Shape + defaults for each param
 *
 * @example
 * const QUERY_CONFIG = {
 *   page:   { defaultValue: 1,           parse: Number },
 *   status: { defaultValue: "PUBLISHED", parse: String },
 *   query:  { defaultValue: "",          parse: String },
 * } as const;
 *
 * const [params, setParams, resetParams] = useQueryState("my-page", QUERY_CONFIG);
 */
export function useQueryState<T extends Record<string, ParamValue>>(storageKey: string, config: ParamConfig<T>) {
  const [searchParams, setSearchParams] = useSearchParams();
  const restoredRef = useRef(false);

  const subscribeToKey = useCallback(
    (listener: () => void) => {
      (listenersByKey[storageKey] ??= new Set()).add(listener);
      return () => listenersByKey[storageKey]?.delete(listener);
    },
    [storageKey],
  );
  const getSnapshot = useCallback(() => memoryStore[storageKey], [storageKey]);
  const snapshot = useSyncExternalStore(subscribeToKey, getSnapshot);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const hasAnyParam = Object.keys(config).some((key) => searchParams.has(key));
    if (hasAnyParam || !snapshot) return;

    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of Object.keys(snapshot)) {
          if (!(key in config)) continue; // stale key from an old config shape - ignore
          const value = snapshot[key];
          if (value !== String(config[key as keyof T]?.defaultValue)) {
            next.set(key, value);
          }
        }
        return next;
      },
      { replace: true },
    );
    // Runs once on mount by design; restoredRef guards re-entry, and we
    // deliberately want the snapshot/searchParams captured at mount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const params = useMemo(
    () =>
      Object.fromEntries(
        typedEntries(config).map(([key, { defaultValue, parse }]) => {
          const fromUrl = searchParams.get(key as string);
          if (fromUrl !== null) {
            const parsed = parse(fromUrl);
            return [key, isValidValue(parsed) ? parsed : defaultValue];
          }
          if (snapshot && (key as string) in snapshot) {
            const parsed = parse(snapshot[key as string]);
            return [key, isValidValue(parsed) ? parsed : defaultValue];
          }
          return [key, defaultValue];
        }),
      ) as unknown as T,
    [searchParams, config, snapshot],
  );

  const setParams = useCallback(
    (updates: Partial<T>, options?: { replace?: boolean }) => {
      let nextSnapshot: Record<string, string> | undefined;

      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of typedEntries(updates)) {
            const { defaultValue, serialize } = config[key];
            const stringValue = serialize ? serialize(value as T[typeof key]) : String(value);
            if (stringValue === String(defaultValue)) {
              next.delete(key as string);
            } else {
              next.set(key as string, stringValue);
            }
          }

          nextSnapshot = Object.fromEntries(
            typedEntries(config).map(([key, { defaultValue }]) => {
              const raw = next.get(key as string);
              return [key as string, raw !== null ? raw : String(defaultValue)];
            }),
          );

          return next;
        },
        { replace: options?.replace ?? false },
      );

      // Mutating memoryStore happens here, after the pure URL computation
      // above - not inside the updater React Router invokes, which should
      // stay side-effect free.
      if (nextSnapshot) writeSnapshot(storageKey, nextSnapshot);
    },
    [config, storageKey, setSearchParams],
  );

  const resetParams = useCallback(() => {
    clearSnapshot(storageKey);
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [storageKey, setSearchParams]);

  return [params, setParams, resetParams] as const;
}
