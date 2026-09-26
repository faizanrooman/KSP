/**
 * Shared UI primitives. All feature screens use these so loading / error / empty / confirmation states,
 * focus handling and keyboard behaviour are consistent (see docs/UI-GUIDELINES.md).
 */
import {
  cloneElement,
  createContext,
  isValidElement,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { clsx } from 'clsx';
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Inbox, Info, Loader2, X, XCircle } from 'lucide-react';
import { errorMessage } from '@/lib/api';
import { titleCase } from '@/lib/format';

export { clsx };

// ---------------------------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-300',
  secondary: 'bg-white text-ink-800 border border-ink-300 hover:bg-ink-50 disabled:text-ink-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-emerald-300',
  ghost: 'text-ink-700 hover:bg-ink-100 disabled:text-ink-400',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium shadow-sm transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------------------------
/**
 * Label + control + hint/error. The label is always programmatically associated: with `htmlFor`, or — when the
 * single child control has no id — with a generated id. Hint/error are linked via aria-describedby and errors set
 * aria-invalid (E2E/axe pass: several dialogs rendered unlabeled controls).
 */
const FORM_CONTROLS = new Set<unknown>(['input', 'select', 'textarea']);

export function Field({ label, hint, error, children, required, htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; required?: boolean; htmlFor?: string }) {
  const autoId = useId();
  const el = isValidElement<Record<string, unknown>>(children) ? children : null;
  // Only real form controls get a generated id; any element already carrying the htmlFor id is enhanced as well.
  const child = el && (FORM_CONTROLS.has(el.type) || (htmlFor !== undefined && el.props.id === htmlFor)) ? el : null;
  const controlId = htmlFor ?? (child?.props.id as string | undefined) ?? (child ? `${autoId}-control` : undefined);
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const describedBy = [child?.props['aria-describedby'] as string | undefined, error ? errorId : hint ? hintId : undefined].filter(Boolean).join(' ') || undefined;
  const control =
    child && (!htmlFor || child.props.id === htmlFor)
      ? cloneElement(child, {
          id: controlId,
          'aria-describedby': describedBy,
          ...(error ? { 'aria-invalid': true } : {}),
          ...(required && child.props.required === undefined ? { 'aria-required': true } : {}),
        })
      : children;
  return (
    <div>
      <label className="label" htmlFor={controlId}>
        {label}
        {required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
      </label>
      {control}
      {hint && !error && <p id={hintId} className="mt-1 text-xs text-ink-500">{hint}</p>}
      {error && <p id={errorId} className="mt-1 text-xs text-red-700" role="alert">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx('input', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx('input min-h-[80px]', className)} {...rest} />;
});

FORM_CONTROLS.add(Input).add(Textarea);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={clsx('input pr-8', className)} {...rest}>
      {children}
    </select>
  );
});
FORM_CONTROLS.add(Select);

export function Checkbox({ label, checked, onChange, disabled, description }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-700 focus:ring-brand-500" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-ink-800">
        {label}
        {description && <span className="block text-xs text-ink-500">{description}</span>}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
export function Card({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  const titleId = useId();
  const named = typeof title === 'string';
  return (
    <section className={clsx('card', className)} aria-labelledby={named ? titleId : undefined}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          {named ? <h2 id={titleId}>{title}</h2> : title}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-xs text-ink-500">{breadcrumb}</div>}
        <h1 className="truncate">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
const tone: Record<string, string> = {
  gray: 'bg-ink-100 text-ink-700 ring-ink-200',
  blue: 'bg-brand-50 text-brand-800 ring-brand-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  purple: 'bg-violet-50 text-violet-800 ring-violet-200',
};
export type Tone = keyof typeof tone;

export function Badge({ children, tone: t = 'gray', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={clsx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', tone[t], className)}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: 'green', REGISTERED: 'green', READY: 'green', COMPLETED: 'green', APPROVED: 'green', RESOLVED: 'green', SUCCESS: 'green', OPEN: 'blue',
  RECEIVED: 'blue', VALIDATING: 'blue', PROCESSING: 'blue', RUNNING: 'blue', QUEUED: 'blue', UPLOADING: 'blue', INITIATED: 'blue', PENDING: 'amber',
  PENDING_APPROVAL: 'amber', NEEDS_SECOND_REVIEW: 'amber', ACKNOWLEDGED: 'amber', WARNING: 'amber', DISPOSAL_PENDING: 'amber', UNDER_INVESTIGATION: 'blue',
  LOCKED: 'red', QUARANTINED: 'red', REJECTED: 'red', FAILED: 'red', CRITICAL: 'red', REVOKED: 'red', DENIED: 'red', FAILURE: 'red', UNSUPPORTED: 'red',
  DISABLED: 'gray', DISPOSED: 'gray', EXPIRED: 'gray', CLOSED: 'gray', ARCHIVED: 'gray', CANCELLED: 'gray', RETIRED: 'gray', ABORTED: 'gray', INFO: 'gray',
  STAGED: 'purple',
};
export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>—</Badge>;
  return <Badge tone={STATUS_TONES[status] ?? 'gray'}>{titleCase(status)}</Badge>;
}

// ---------------------------------------------------------------------------------------------
export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={clsx('flex items-center justify-center gap-2 py-10 text-sm text-ink-500', className)} role="status" aria-live="polite">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, description, action, icon, heading }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; heading?: 'h1' | 'h2' }) {
  const Title = heading ?? 'p';
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-ink-300" aria-hidden>{icon ?? <Inbox className="h-10 w-10" aria-hidden />}</div>
      <Title className={clsx('font-medium text-ink-700', heading && 'text-base')}>{title}</Title>
      {description && <p className="max-w-md text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" role="alert">
      <AlertTriangle className="h-8 w-8 text-red-500" aria-hidden />
      <p className="font-medium text-ink-800">{title}</p>
      <p className="max-w-lg text-sm text-ink-600">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone: t = 'blue', title, children }: { tone?: 'blue' | 'amber' | 'red' | 'green'; title?: string; children?: ReactNode }) {
  const Icon = t === 'red' ? XCircle : t === 'amber' ? AlertTriangle : t === 'green' ? CheckCircle2 : Info;
  const cls = { blue: 'bg-brand-50 text-brand-900 border-brand-200', amber: 'bg-amber-50 text-amber-900 border-amber-200', red: 'bg-red-50 text-red-900 border-red-200', green: 'bg-emerald-50 text-emerald-900 border-emerald-200' }[t];
  return (
    <div className={clsx('flex gap-2 rounded-md border px-3 py-2 text-sm', cls)} role={t === 'red' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortKey?: string;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  empty,
  onRowClick,
  sort,
  onSort,
  caption,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  sort?: string;
  onSort?: (sort: string) => void;
  caption?: string;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !rows) return <Spinner />;
  if (!rows || rows.length === 0) return <>{empty ?? <EmptyState title="No records found" />}</>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-ink-200 text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-ink-50">
          <tr>
            {columns.map((c) => {
              const active = sort === c.sortKey || sort === `-${c.sortKey}`;
              const desc = sort === `-${c.sortKey}`;
              return (
                <th key={c.key} scope="col" className={clsx('whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-600', c.className)} aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}>
                  {c.sortKey && onSort ? (
                    <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={() => onSort(active && !desc ? `-${c.sortKey}` : c.sortKey!)}>
                      {c.header}
                      {active && <span aria-hidden>{desc ? '↓' : '↑'}</span>}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className={clsx('divide-y divide-ink-100 bg-white', loading && 'opacity-60')}>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={clsx(onRowClick && 'cursor-pointer hover:bg-brand-50/40 focus-within:bg-brand-50/40')}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={clsx('px-3 py-2 align-top text-ink-800', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="flex items-center justify-between border-t border-ink-100 px-3 py-2 text-sm text-ink-600" aria-label="Pagination">
      <span>
        {from}–{to} of {total.toLocaleString('en-IN')}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" icon={<ChevronLeft className="h-4 w-4" />} />
        <span className="px-2">
          Page {page} / {pages}
        </span>
        <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page" icon={<ChevronRight className="h-4 w-4" />} />
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'));
    // Respect a child's autoFocus (e.g. the reason textarea). Moving focus to the first focusable (the Close
    // button) meant typed text hit Close on Space and then the page's single-key shortcuts (E2E finding BUG-05).
    if (!el?.contains(document.activeElement)) {
      const field = el?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      (field ?? focusables()[0] ?? el)?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/50 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={clsx('w-full rounded-lg bg-white shadow-xl', width)}>
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <h2 id={titleId}>{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-500 hover:bg-ink-100" aria-label="Close dialog">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/**
 * Confirmation for consequential actions. With `requireReason`, the user must type a justification
 * (recorded in the audit trail by the caller).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'primary',
  requireReason,
  reasonLabel = 'Reason',
  minReason = 5,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  variant?: Variant;
  requireReason?: boolean;
  reasonLabel?: string;
  minReason?: number;
  loading?: boolean;
  error?: unknown;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const valid = !requireReason || reason.trim().length >= minReason;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={variant} onClick={() => onConfirm(reason.trim())} disabled={!valid} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-700">
        <div>{message}</div>
        {requireReason && (
          <Field label={reasonLabel} required hint={`At least ${minReason} characters; recorded in the audit trail.`}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
        )}
        {error ? <Alert tone="red">{errorMessage(error)}</Alert> : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (v: T) => void }) {
  return (
    <div
      role="tablist"
      className="mb-4 flex gap-1 overflow-x-auto border-b border-ink-200"
      onKeyDown={(e) => {
        // WAI-ARIA tabs: ←/→ (wrapping), Home/End move between tabs and activate them; Tab leaves the tablist.
        const i = tabs.findIndex((t) => t.id === value);
        const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0 || !tabs[next]) return;
        e.preventDefault();
        onChange(tabs[next]!.id);
        const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        requestAnimationFrame(() => buttons[next]?.focus());
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-brand-700 text-brand-800' : 'border-transparent text-ink-600 hover:text-ink-900')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded bg-ink-100 px-1.5 text-xs text-ink-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ items, columns = 2 }: { items: Array<{ label: string; value: ReactNode; mono?: boolean } | false | null | undefined>; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3 text-sm', columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3')}>
      {items.filter(Boolean).map((i) => {
        const it = i as { label: string; value: ReactNode; mono?: boolean };
        return (
          <div key={it.label} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{it.label}</dt>
            <dd className={clsx('mt-0.5 break-words text-ink-900', it.mono && 'mono break-all')}>{it.value ?? '—'}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Stat({ label, value, sub, tone: t }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className={clsx('mt-1 text-2xl font-semibold', t === 'red' ? 'text-red-700' : t === 'amber' ? 'text-amber-700' : t === 'green' ? 'text-emerald-700' : 'text-ink-900')}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-500">{sub}</p>}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded px-1 text-xs text-brand-700 hover:bg-brand-50"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label={`${label} to clipboard`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : label}
    </button>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="w-full" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <div className="h-2 w-full overflow-hidden rounded bg-ink-100">
        <div className="h-full rounded bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: string;
}
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.tone === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto flex items-start gap-2 rounded-md px-3 py-2 text-sm text-white shadow-lg', t.tone === 'success' ? 'bg-emerald-700' : t.tone === 'error' ? 'bg-red-700' : 'bg-ink-800')} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span className="flex-1">{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    success: (message: string) => push({ tone: 'success', message }),
    error: (e: unknown) => push({ tone: 'error', message: typeof e === 'string' ? e : errorMessage(e) }),
    info: (message: string) => push({ tone: 'info', message }),
  };
}
