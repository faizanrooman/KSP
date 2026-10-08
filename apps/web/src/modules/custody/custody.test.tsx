/** CustodyTab paging (FN-19): first page, "Load more" with the server's nextAfter cursor, server-side filter. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { CustodyTab, type CustodyEvent, type CustodyResponse } from './CustodyTab';

const ev = (seq: number, custody = true): CustodyEvent => ({
  seq, eventId: `e${seq}`, occurredAt: '2026-09-01T10:00:00.000Z', action: custody ? 'EVIDENCE_VIEWED' : 'MEDIA_PROCESSING_COMPLETED', category: 'EVIDENCE', custody,
  outcome: 'SUCCESS', actor: { type: 'USER', id: 'u', username: 'io.meera', name: 'Meera' }, ip: null, resourceType: 'evidence', resourceId: 'x', caseId: null,
  details: {}, prevHash: '0'.repeat(64), hash: String(seq).padStart(64, 'a'), verified: true,
});
const verification = { chainIntact: true, eventsChecked: 250, brokenSeqs: [], ledgerHead: { seq: 9999, hash: 'f'.repeat(64) }, verifiedAt: '2026-09-01T10:00:00.000Z' };
const page = (events: CustodyEvent[], p: Partial<CustodyResponse['page']>): CustodyResponse => ({
  evidence: { id: 'x', evidenceNumber: 'KA-1', sha256: null, sha512: null, status: 'REGISTERED' },
  events,
  page: { limit: 200, filter: 'all', total: 250, hasMore: false, hasEarlier: false, nextAfter: null, prevBefore: null, ...p },
  verification,
});

afterEach(() => vi.restoreAllMocks());

describe('CustodyTab paging', () => {
  it('loads the next keyset page on "Load more" and passes the filter to the server', async () => {
    const first = Array.from({ length: 200 }, (_, i) => ev(i + 1));
    const second = Array.from({ length: 50 }, (_, i) => ev(i + 201));
    const get = vi.spyOn(api, 'get').mockImplementation(async (_url: string, q?: Record<string, unknown>) => {
      if (q?.filter === 'all') return page([ev(7, false)], { filter: 'all', total: 1 }) as never;
      return (q?.after === 200 ? page(second, { filter: 'custody', hasEarlier: true, prevBefore: 201 }) : page(first, { filter: 'custody', hasMore: true, nextAfter: 200 })) as never;
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CustodyTab evidence={{ id: 'x' } as never} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText((_, el) => /^Showing 200 of 250 custody events/.test(el?.textContent ?? '') && !el?.children.length)).toBeTruthy();
    expect(await screen.findByText((_, el) => /All 250 ledger events/.test(el?.textContent ?? '') && !el?.querySelector('p, div'))).toBeTruthy(); // whole-chain verification, not just the page
    fireEvent.click(screen.getByRole('button', { name: 'Load more (50 of 50 remaining)' }));
    expect(await screen.findByText((_, el) => /^Showing 250 of 250 custody events/.test(el?.textContent ?? '') && !el?.children.length)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
    expect(get).toHaveBeenCalledWith('/custody/evidence/x', { filter: 'custody', limit: 200, after: 200 });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByText('Showing 1 of 1 linked events')).toBeTruthy());
    expect(get).toHaveBeenCalledWith('/custody/evidence/x', { filter: 'all', limit: 200, after: undefined });
  });
});
