import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: Error | null;
  /** True only before the first response; refreshes keep showing the previous data. */
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetches now and then every `intervalMs` while the tab is visible. Previous data stays on
 * screen during refreshes (no skeleton flash), and stale responses are dropped.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[]): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    const mine = generation.current;
    setRefreshing(true);
    try {
      const result = await fetcherRef.current();
      if (mine === generation.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === generation.current) setError(err as Error);
    } finally {
      if (mine === generation.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    generation.current++;
    setData(undefined);
    setError(null);
    void run();
    if (!intervalMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run, intervalMs, ...deps]);

  return { data, error, loading: data === undefined && error === null, refreshing, refresh: run };
}

/** Re-renders every `intervalMs` so relative times ("12s ago") stay fresh. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
