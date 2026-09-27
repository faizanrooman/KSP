import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useUrlState } from './hooks';

afterEach(cleanup);

const DEFAULTS = { status: 'OPEN', q: '', page: '1' };
let api: ReturnType<typeof useUrlState<typeof DEFAULTS>>;
function Probe() {
  api = useUrlState(DEFAULTS);
  return <output>{JSON.stringify(api[0])}</output>;
}
const state = () => JSON.parse(screen.getByRole('status').textContent ?? '{}') as typeof DEFAULTS;

describe('useUrlState', () => {
  it('keeps an explicit empty choice for a key with a non-empty default (UI-B-13: "Any status")', () => {
    render(<MemoryRouter><Probe /></MemoryRouter>);
    expect(state().status).toBe('OPEN');
    act(() => api[1]({ status: '' }));
    expect(state().status).toBe('');
    act(() => api[1]({ status: 'OPEN' }));
    expect(state().status).toBe('OPEN');
  });

  it('drops empty values for keys whose default is empty and resets the page on filter changes', () => {
    render(<MemoryRouter initialEntries={['/?page=3&q=x']}><Probe /></MemoryRouter>);
    expect(state()).toMatchObject({ q: 'x', page: '3' });
    act(() => api[1]({ q: '' }));
    expect(state()).toMatchObject({ q: '', page: '1' });
  });
});
