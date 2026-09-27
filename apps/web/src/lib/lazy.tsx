/**
 * Route-level code splitting (FN-24). Module registries (`module.tsx`, `evidence-tabs.tsx`, …) stay eager — they
 * only carry metadata — while page/tab components are `React.lazy` wrappers created with `lazyPage`, so each page
 * and its dependencies (video player + hls.js, charts, …) become separate chunks loaded on first use.
 *
 * `LazyBoundary` wraps lazily rendered content: a Suspense fallback while the chunk loads and a retryable error
 * state if it fails (e.g. a stale chunk after a deployment → "Reload").
 */
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Button, Spinner } from '@/components/ui';

/**
 * `lazyPage(() => import('./EvidenceListPage'), 'EvidenceListPage')` → a lazy component with the named export's
 * exact props. The loader must be an inline `import()` so Vite can split it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K): M[K] {
  const C = lazy(() => load().then((m) => ({ default: m[name] })));
  (C as { displayName?: string }).displayName = `Lazy(${name})`;
  return C as unknown as M[K];
}

class ChunkErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="alert">
        <p className="font-medium text-ink-800">This part of the application could not be loaded</p>
        <p className="max-w-lg text-sm text-ink-600">{this.state.error.message || 'Network error'} — the application may have been updated.</p>
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload</Button>
      </div>
    );
  }
}

export function LazyBoundary({ children, label = 'Loading…', className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<Spinner label={label} className={className} />}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}
