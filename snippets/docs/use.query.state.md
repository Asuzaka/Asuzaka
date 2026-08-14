# `useQueryState`

A typed React hook that synchronizes component state with URL search
parameters, with automatic **in-memory persistence** across navigation.

Built on top of `react-router`'s `useSearchParams`, it lets a page define a
typed shape for its query params (pagination, filters, search text, sort
order, etc.), read/write them with full type safety, and — critically —
**restore the last-used values** when a user navigates away and back to the
page, even after the URL itself has been reset to its defaults.

---

## Table of contents

- [Why this hook exists](#why-this-hook-exists)
- [Installation / requirements](#installation--requirements)
- [Quick start](#quick-start)
- [API reference](#api-reference)
  - [`useQueryState(storageKey, config)`](#usequerystatestoragekey-config)
  - [`ParamConfig`](#paramconfig)
  - [Return value](#return-value)
- [How it works](#how-it-works)
  - [Value resolution priority](#value-resolution-priority)
  - [The in-memory store](#the-in-memory-store)
  - [Restoring on mount](#restoring-on-mount)
  - [Clean URLs (defaults are never persisted)](#clean-urls-defaults-are-never-persisted)
- [Usage examples](#usage-examples)
  - [Basic pagination + filters](#1-basic-pagination--filters)
  - [Custom parse / serialize (booleans, arrays, dates)](#2-custom-parse--serialize-booleans-arrays-dates)
  - [Updating multiple params at once](#3-updating-multiple-params-at-once)
  - [Push vs. replace history](#4-push-vs-replace-history)
  - [Resetting all params](#5-resetting-all-params)
  - [Debounced search input](#6-debounced-search-input)
- [Behavior details & edge cases](#behavior-details--edge-cases)
- [Best practices](#best-practices)
- [Full type reference](#full-type-reference)
- [Troubleshooting / FAQ](#troubleshooting--faq)

---

## Why this hook exists

Plain `useSearchParams` gives you the URL as the single source of truth,
but two problems come up constantly in real apps:

1. **No type safety.** Every param is a raw string; you re-parse and
   re-validate it everywhere it's read.
2. **State is lost on navigation.** If a user sets filters on a list page,
   clicks into a detail view, and hits "back," the browser's history
   usually restores the URL — but not if the list page resets its params on
   mount, or if the user reached the page from a fresh link.

`useQueryState` solves both: you declare a typed config once, and the hook
takes care of parsing, serializing, syncing with the URL, and quietly
remembering the last-used values for the lifetime of the browser tab.

---

## Installation / requirements

- **React** 18+ (uses `useSyncExternalStore`)
- **react-router** (uses `useSearchParams` from `react-router`)

No other dependencies. Drop the hook file into your project (e.g.
`hooks/useQueryState.ts`) and import it directly.

---

## Quick start

```tsx
import { useQueryState } from "@/hooks/useQueryState";

// Define once, outside the component — see "Best practices" below.
const QUERY_CONFIG = {
  page: { defaultValue: 1, parse: Number },
  status: { defaultValue: "PUBLISHED", parse: String },
  query: { defaultValue: "", parse: String },
} as const;

function DocumentsPage() {
  const [params, setParams, resetParams] = useQueryState("my-documents", QUERY_CONFIG);

  return (
    <div>
      <input value={params.query} onChange={(e) => setParams({ query: e.target.value, page: 1 })} />

      <Select value={params.status} onChange={(status) => setParams({ status, page: 1 })} />

      <Pagination page={params.page} onChange={(page) => setParams({ page })} />

      <button onClick={resetParams}>Clear filters</button>
    </div>
  );
}
```

The URL will read something like:

```
/documents?query=invoice&status=DRAFT&page=2
```

...and `page=1` / `status=PUBLISHED` never appear in the URL, since they
match the declared defaults.

---

## API reference

### `useQueryState(storageKey, config)`

```ts
function useQueryState<T extends Record<string, string | number>>(
  storageKey: string,
  config: ParamConfig<T>,
): readonly [T, SetParams<T>, () => void];
```

| Parameter    | Type             | Description                                                                                                                                  |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageKey` | `string`         | A unique identifier for the page/view, e.g. `"my-documents"`. Used as the key for the in-memory snapshot store. **Must be unique per page.** |
| `config`     | `ParamConfig<T>` | Describes every param's shape: its default value, how to parse it from a URL string, and (optionally) how to serialize it back to a string.  |

### `ParamConfig`

```ts
type ParamValue = string | number;

type ParamConfig<T extends Record<string, ParamValue>> = {
  [K in keyof T]: {
    defaultValue: T[K];
    parse: (value: string) => T[K];
    serialize?: (value: T[K]) => string;
  };
};
```

For each key in your state shape `T`, you provide:

- **`defaultValue`** — the value used when the param is absent from both
  the URL and the in-memory snapshot. Also the value that causes the param
  to be _omitted_ from the URL when set (see [Clean URLs](#clean-urls-defaults-are-never-persisted)).
- **`parse`** — converts the raw URL string into the typed value
  (`Number`, `String`, or a custom function).
- **`serialize`** _(optional)_ — converts the typed value back into a URL
  string. Defaults to `String(value)` if omitted. Provide this for types
  that don't round-trip cleanly through `String()`, such as arrays,
  booleans stored as `0`/`1`, or enums with custom encodings.

> **Note:** `ParamValue` is restricted to `string | number`. If you need
> booleans, dates, arrays, or objects, encode/decode them via `parse` /
> `serialize` (see [example 2](#2-custom-parse--serialize-booleans-arrays-dates)).

### Return value

`useQueryState` returns a tuple: `[params, setParams, resetParams]`.

#### `params: T`

The current, fully-typed param values, memoized and recomputed whenever the
URL or the underlying snapshot changes.

#### `setParams(updates, options?)`

```ts
function setParams(updates: Partial<T>, options?: { replace?: boolean }): void;
```

Updates one or more params at once.

- `updates` — a partial object; only the keys you pass are changed, the
  rest are left as-is.
- `options.replace` — when `true`, uses `history.replaceState` instead of
  `pushState` (no new browser history entry). Defaults to `false`.

Every call to `setParams` also updates the in-memory snapshot for
`storageKey`, so the change is remembered.

#### `resetParams()`

```ts
function resetParams(): void;
```

Clears **all** params — both in the URL (reset to an empty query string)
and in the in-memory snapshot for `storageKey`. Always uses
`replace: true` internally so it doesn't add a history entry.

---

## How it works

### Value resolution priority

For each key, `params` is computed in this order:

```
URL search param  >  in-memory snapshot  >  defaultValue
```

1. If the key exists in the current URL, its value is parsed and used
   (falling back to `defaultValue` if parsing produces `NaN`).
2. Otherwise, if a snapshot exists for `storageKey` and contains the key,
   that value is parsed and used.
3. Otherwise, `defaultValue` is used.

This means the **URL always wins** — deep links and shared URLs behave
exactly as the URL says, regardless of what's remembered in memory.

### The in-memory store

```ts
const memoryStore: Record<string, Record<string, string>> = {};
const listenersByKey: Record<string, Set<() => void>> = {};
```

A module-level object keyed by `storageKey`, holding the last known string
value for every configured param. Because it lives at module scope (not in
component state), it:

- **Survives** component unmount/remount and client-side navigation.
- **Does not survive** a full page reload or new tab (it's plain JS memory,
  not `localStorage`/`sessionStorage`).

Each `storageKey` also has a `Set` of listener callbacks. The hook
subscribes to its key via `useSyncExternalStore`, so any component reading
that `storageKey` re-renders whenever the snapshot is written — even if the
write happens from a different mounted instance of the hook (e.g. two
components sharing the same `storageKey`).

### Restoring on mount

```ts
useEffect(() => {
  if (restoredRef.current) return;
  restoredRef.current = true;

  const hasAnyParam = Object.keys(config).some((key) => searchParams.has(key));
  if (hasAnyParam || !snapshot) return;

  setSearchParams(/* write snapshot values into the URL */, { replace: true });
}, []);
```

On first mount only (`restoredRef` guards against re-entry, and the effect
has an intentionally empty dependency array):

- If the URL **already has** any of the configured params (e.g. the user
  followed a link with `?status=DRAFT`), the hook does nothing — the URL is
  respected as-is.
- If the URL has **none** of the configured params and a snapshot **exists**
  for this `storageKey`, the hook writes the non-default snapshot values
  into the URL via `replace: true` (no new history entry, no visible
  navigation).

This is what makes the "leave the page, come back, filters are still
there" behavior work, even when the page's URL doesn't carry the params on
initial load (e.g. navigating via a sidebar link that always points to the
bare `/documents` path).

Keys present in the snapshot but no longer present in `config` (e.g. a
param that existed in a previous version of the page) are silently
ignored — this guards against stale shapes left over from old sessions.

### Clean URLs (defaults are never persisted)

Both the mount-restore effect and `setParams` skip writing a param to the
URL when its value equals the declared `defaultValue`:

```ts
if (stringValue === String(defaultValue)) {
  next.delete(key);
} else {
  next.set(key, stringValue);
}
```

This keeps URLs minimal and shareable — `/documents` instead of
`/documents?page=1&status=PUBLISHED&query=`.

---

## Usage examples

### 1. Basic pagination + filters

```tsx
const QUERY_CONFIG = {
  page: { defaultValue: 1, parse: Number },
  status: { defaultValue: "PUBLISHED", parse: String },
  query: { defaultValue: "", parse: String },
} as const;

function DocumentsPage() {
  const [{ page, status, query }, setParams] = useQueryState("my-documents", QUERY_CONFIG);

  const { data } = useDocumentsQuery({ page, status, query });

  return (
    <>
      <SearchBox value={query} onChange={(query) => setParams({ query, page: 1 })} />
      <StatusFilter value={status} onChange={(status) => setParams({ status, page: 1 })} />
      <DocumentTable data={data} />
      <Pagination page={page} onChange={(page) => setParams({ page })} />
    </>
  );
}
```

Note the pattern of resetting `page: 1` whenever a filter changes — a
common UX requirement that's just a normal part of the `updates` object.

### 2. Custom parse / serialize (booleans, arrays, dates)

`ParamValue` only allows `string | number`, so richer types are encoded
through `parse`/`serialize`:

```tsx
const QUERY_CONFIG = {
  // boolean, encoded as "1" / "0"
  archived: {
    defaultValue: 0,
    parse: (v) => (v === "1" ? 1 : 0),
    serialize: (v) => (v ? "1" : "0"),
  },
  // string array, comma-separated
  tags: {
    defaultValue: "",
    parse: String,
    serialize: String,
  },
  // ISO date string
  since: {
    defaultValue: "",
    parse: String,
  },
} as const;
```

For a genuinely boolean or array-typed `params` object in your component,
wrap the hook and map the encoded values:

```tsx
function useDocumentFilters() {
  const [raw, setRaw, reset] = useQueryState("my-documents", QUERY_CONFIG);

  const params = {
    archived: raw.archived === 1,
    tags: raw.tags ? raw.tags.split(",") : [],
    since: raw.since,
  };

  const setParams = (updates: { archived?: boolean; tags?: string[]; since?: string }) =>
    setRaw({
      ...(updates.archived !== undefined && { archived: updates.archived ? 1 : 0 }),
      ...(updates.tags !== undefined && { tags: updates.tags.join(",") }),
      ...(updates.since !== undefined && { since: updates.since }),
    });

  return [params, setParams, reset] as const;
}
```

### 3. Updating multiple params at once

```tsx
setParams({ page: 1, status: "DRAFT", query: "" });
```

All keys are batched into a single `setSearchParams` call — and therefore
a single URL update and a single snapshot write — even though several
values changed.

### 4. Push vs. replace history

```tsx
// Adds a new browser history entry (default) — good for filter changes
// the user might want to "back" out of.
setParams({ status: "DRAFT" });

// Replaces the current history entry — good for high-frequency changes
// like live-typing search or page-size drags, where you don't want to
// spam the back button.
setParams({ query: "invoice" }, { replace: true });
```

### 5. Resetting all params

```tsx
function ClearFiltersButton() {
  const [, , resetParams] = useQueryState("my-documents", QUERY_CONFIG);
  return <button onClick={resetParams}>Clear all filters</button>;
}
```

This clears the URL and forgets the in-memory snapshot, so navigating away
and back afterward starts from defaults again.

### 6. Debounced search input

```tsx
function SearchBox() {
  const [{ query }, setParams] = useQueryState("my-documents", QUERY_CONFIG);
  const [local, setLocal] = useState(query);

  useEffect(() => {
    const id = setTimeout(() => {
      if (local !== query) setParams({ query: local, page: 1 }, { replace: true });
    }, 300);
    return () => clearTimeout(id);
  }, [local]);

  return <input value={local} onChange={(e) => setLocal(e.target.value)} />;
}
```

Using `replace: true` here avoids creating a history entry per keystroke.

---

## Behavior details & edge cases

| Scenario                                                                     | Behavior                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Invalid numeric param** (e.g. `?page=abc`)                                 | `parse` runs (`Number("abc")` → `NaN`), `isValidValue` rejects it, and `defaultValue` is used instead — for both URL-sourced and snapshot-sourced values.                                                                        |
| **Full page reload / new tab**                                               | The in-memory store is empty (it's plain module state, not persisted storage), so params start from the URL, or defaults if the URL is bare.                                                                                     |
| **Two components use the same `storageKey`**                                 | They share one snapshot and are kept in sync: a `setParams` call in one triggers a re-render with fresh `params` in the other, via `useSyncExternalStore`.                                                                       |
| **Config shape changes between deploys** (e.g. a param is removed)           | Stale keys in an old snapshot that no longer exist in `config` are skipped during mount-restore — they won't cause errors or leak into the URL.                                                                                  |
| **User deep-links with some but not all params** (e.g. only `?status=DRAFT`) | `hasAnyParam` is `true`, so mount-restore is skipped entirely — the URL is taken as-is, and any params it _doesn't_ specify simply fall back to `defaultValue` (not the snapshot), since the snapshot restore is all-or-nothing. |
| **`setParams` called with a value equal to the default**                     | The param is removed from the URL, keeping it clean; the snapshot still records it (as the default) for future restore checks.                                                                                                   |
| **StrictMode double-invoked effects**                                        | `restoredRef` ensures the mount-restore logic only executes its side effect once per mount, even if the effect body runs twice.                                                                                                  |

---

## Best practices

- **Define `config` at module scope**, not inline inside the component:

  ```ts
  // ✅ good — stable reference, no unnecessary re-renders
  const QUERY_CONFIG = { page: { defaultValue: 1, parse: Number } } as const;
  function Page() {
    const [params] = useQueryState("page", QUERY_CONFIG);
  }

  // ❌ avoid — new object every render, breaks memoization
  function Page() {
    const [params] = useQueryState("page", { page: { defaultValue: 1, parse: Number } });
  }
  ```

- **Use `as const`** on your config object so TypeScript infers literal
  default types (e.g. `"PUBLISHED"` instead of `string`) and gives you
  precise typing on `params`.

- **Pick a unique, stable `storageKey` per page.** Two different pages
  sharing a key will share state, which is almost never what you want.

- **Reset dependent params together.** When a filter changes, reset
  pagination in the same `setParams` call (`setParams({ status, page: 1 })`)
  rather than issuing two calls.

- **Use `replace: true` for high-frequency updates** (typing, dragging,
  sliders) and the default push behavior for discrete user choices
  (selecting a filter, changing tabs) that should be back-button-able.

---

## Full type reference

```ts
type ParamValue = string | number;

type ParamConfig<T extends Record<string, ParamValue>> = {
  [K in keyof T]: {
    defaultValue: T[K];
    parse: (value: string) => T[K];
    serialize?: (value: T[K]) => string;
  };
};

function useQueryState<T extends Record<string, ParamValue>>(
  storageKey: string,
  config: ParamConfig<T>,
): readonly [T, (updates: Partial<T>, options?: { replace?: boolean }) => void, () => void];
```

---

## Troubleshooting / FAQ

**Q: My params reset to defaults every time I revisit the page.**
Check that `storageKey` is identical across mounts (it's often accidentally
derived from a route param or generated inline) and that `config` is a
stable, module-level reference.

**Q: A param I removed from `config` still shows up somewhere.**
It won't appear in the URL or in `params` — but it may still linger in the
in-memory snapshot object for that `storageKey` until the next
`setParams`/`resetParams` call overwrites the snapshot, or the tab is
closed. This is harmless since stale keys are filtered out on read.

**Q: Can I use this outside of `react-router`?**
No — it depends directly on `useSearchParams` from `react-router`. For
other routers, you'd need to swap that piece out.

**Q: Does this persist across page reloads or browser restarts?**
No. The snapshot lives in module-level JS memory (not `localStorage` or
`sessionStorage`), so it resets on full page reload, closing the tab, or
navigating via a full (non-client-side) page load. It's designed for
_within-session_ client-side navigation, not long-term persistence.
