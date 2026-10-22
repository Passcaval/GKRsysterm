import { useEffect, useState } from "react";
import { api } from "./api";
import { errorText } from "./transport";
import type { AtlasSearchResult } from "./types";
import type { AtlasContext } from "./navigator-state";
const pending = new Map<string, Promise<AtlasSearchResult>>();
const cache = new Map<string, { at: number; value: AtlasSearchResult }>();
export function useAtlasResults(context: AtlasContext) {
  const key = JSON.stringify(context);
  const [state, setState] = useState<{
    key: string;
    value: AtlasSearchResult | null;
    loading: boolean;
    error: string;
  }>({ key, value: null, loading: true, error: "" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ key, value: null, loading: true, error: "" });
    const saved = cache.get(key);
    let promise =
      saved && Date.now() - saved.at < 60000
        ? Promise.resolve(saved.value)
        : pending.get(key);
    if (!promise) {
      promise = api
        .atlasSearch(JSON.parse(key))
        .then((value) => {
          if (cache.size > 30) cache.clear();
          cache.set(key, { at: Date.now(), value });
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, promise);
    }
    promise
      .then((value) => {
        if (active) setState({ key, value, loading: false, error: "" });
      })
      .catch((e) => {
        if (active)
          setState({ key, value: null, loading: false, error: errorText(e) });
      });
    return () => {
      active = false;
    };
  }, [key, retry]);
  return {
    ...(state.key === key
      ? state
      : { key, value: null, loading: true, error: "" }),
    retry: () => {
      cache.delete(key);
      setRetry((v) => v + 1);
    },
  };
}
