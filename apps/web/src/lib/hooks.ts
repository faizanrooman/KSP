import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Filter/pagination state stored in the URL query string (shareable, survives reload, back-button friendly).
 */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => {
    const out = { ...defaults } as Record<string, string>;
    for (const k of Object.keys(defaults)) {
      const v = params.get(k);
      if (v !== null) out[k] = v;
    }
    return out as T;
  }, [params, defaults]);
  const update = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === '' || v === defaults[k]) next.delete(k);
            else next.set(k, String(v));
          }
          if (!('page' in patch) && 'page' in defaults) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaults],
  );
  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  return [state, update, reset];
}
