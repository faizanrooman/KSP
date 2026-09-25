/** Shared pickers backed by /api/v1/directory. */
import { useEffect, useId, useState } from 'react';
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
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['directory', 'users', debounced, orgUnitId],
    queryFn: () => api.get<{ items: UserOption[] }>('/directory/users', { q: debounced, orgUnitId }),
    enabled: open,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-ink-300 bg-white px-3 py-2 text-sm">
        <span>
          {value.fullName} <span className="text-ink-500">{value.badgeNumber ? `(${value.badgeNumber})` : `@${value.username}`} · {value.orgUnitName}</span>
        </span>
        <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => onChange(null)}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input id={id} role="combobox" aria-expanded={open} aria-controls={listId} autoComplete="off" placeholder={placeholder} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-ink-200 bg-white py-1 text-sm shadow-lg">
          {isFetching && !data && <li className="px-3 py-2 text-ink-500">Searching…</li>}
          {data?.items.length === 0 && <li className="px-3 py-2 text-ink-500">No users found</li>}
          {data?.items.map((u) => (
            <li key={u.id} role="option" aria-selected={false}>
              <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-brand-50" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(u); setQ(''); setOpen(false); }}>
                {u.fullName} <span className="text-ink-500">{u.badgeNumber ?? `@${u.username}`} · {u.orgUnitName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
