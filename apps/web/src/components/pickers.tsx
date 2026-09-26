/** Shared pickers backed by /api/v1/directory. */
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Input, Select } from '@/components/ui';

export interface OrgUnitOption {
  id: string;
  code: string;
  name: string;
  unitType: string;
  parentId: string | null;
  path: string;
  depth: number;
  active: boolean;
}

export function useOrgUnits() {
  return useQuery({ queryKey: ['directory', 'org-units'], queryFn: () => api.get<{ items: OrgUnitOption[] }>('/directory/org-units'), staleTime: 5 * 60_000 });
}

export function OrgUnitSelect({ value, onChange, id, allowEmpty = true, emptyLabel = 'All units', stationsOnly, required, disabled }: {
  value: string; onChange: (id: string) => void; id?: string; allowEmpty?: boolean; emptyLabel?: string; stationsOnly?: boolean; required?: boolean; disabled?: boolean;
}) {
  const { data, isLoading } = useOrgUnits();
  const items = (data?.items ?? []).filter((u) => !stationsOnly || u.unitType === 'STATION');
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={required} disabled={disabled || isLoading}>
      {allowEmpty && <option value="">{isLoading ? 'Loading…' : emptyLabel}</option>}
      {items.map((u) => (
        <option key={u.id} value={u.id}>
          {stationsOnly ? u.name : `${'  '.repeat(u.depth)}${u.name}`}
        </option>
      ))}
    </Select>
  );
}

export interface UserOption {
  id: string;
  username: string;
  fullName: string;
  badgeNumber: string | null;
  rank: string | null;
  orgUnitId: string;
  orgUnitName: string;
}

/** Type-ahead user picker. `value` is the selected user (or null). */
export function UserPicker({ value, onChange, id, placeholder = 'Search by name, username or badge…', orgUnitId }: {
  value: UserOption | null; onChange: (u: UserOption | null) => void; id?: string; placeholder?: string; orgUnitId?: string;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  // Highlight by user id, so late (debounced) results do not move or clear it under the keyboard user.
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocus = useRef<'change' | 'input' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['directory', 'users', debounced, orgUnitId],
    queryFn: () => api.get<{ items: UserOption[] }>('/directory/users', { q: debounced, orgUnitId }),
    enabled: open,
  });
  const items = data?.items ?? [];
  const active = items.findIndex((u) => u.id === activeId);
  // Keep keyboard focus on the control after picking / clearing (it swaps between input and "Change" button).
  useEffect(() => {
    if (refocus.current === 'change') changeRef.current?.focus();
    if (refocus.current === 'input') inputRef.current?.focus();
    refocus.current = null;
  }, [value]);
  const pick = (u: UserOption) => {
    refocus.current = 'change';
    onChange(u);
    setQ('');
    setOpen(false);
  };
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-ink-300 bg-white px-3 py-2 text-sm">
        <span id={id ? `${id}-value` : undefined}>
          {value.fullName} <span className="text-ink-500">{value.badgeNumber ? `(${value.badgeNumber})` : `@${value.username}`} · {value.orgUnitName}</span>
        </span>
        <button
          ref={changeRef}
          type="button"
          className="text-xs text-brand-700 hover:underline"
          aria-describedby={id ? `${id}-value` : undefined}
          onClick={() => {
            refocus.current = 'input';
            onChange(null);
          }}
        >
          Change
        </button>
      </div>
    );
  }
  // WAI-ARIA combobox: ↓/↑ move through options (aria-activedescendant), Enter picks, Escape closes.
  // Before: options were buttons inside role=option and Tab closed the list on blur — not keyboard operable.
  const optionId = (u: UserOption) => `${listId}-${u.id}`;
  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? optionId(items[active]!) : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            const n = items[Math.min(items.length - 1, active + 1)];
            if (n) setActiveId(n.id);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const n = items[Math.max(0, active - 1)];
            if (n) setActiveId(n.id);
          } else if (e.key === 'Enter' && open && items[active]) {
            e.preventDefault();
            pick(items[active]!);
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Matching users" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-ink-200 bg-white py-1 text-sm shadow-lg">
          {isFetching && !data && <li role="presentation" className="px-3 py-2 text-ink-500">Searching…</li>}
          {data?.items.length === 0 && <li role="presentation" className="px-3 py-2 text-ink-500">No users found</li>}
          {items.map((u, i) => (
            <li
              key={u.id}
              id={optionId(u)}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-1.5 ${i === active ? 'bg-brand-100' : 'hover:bg-brand-50'}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(u)}
            >
              {u.fullName} <span className="text-ink-500">{u.badgeNumber ?? `@${u.username}`} · {u.orgUnitName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
