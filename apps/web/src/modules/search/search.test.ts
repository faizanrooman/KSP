import { describe, expect, it } from 'vitest';
import { compactCriteria, countCriteria, decodeCriteria, encodeCriteria, momentLink } from './api';

describe('search criteria URL state', () => {
  it('compacts empty values and default AI review status', () => {
    expect(compactCriteria({ text: '', tags: [], ai: { labels: [], reviewStatus: 'APPROVED' }, statuses: ['REGISTERED'] })).toEqual({ statuses: ['REGISTERED'] });
    expect(compactCriteria({ ai: { reviewStatus: 'ANY_NON_REJECTED' } })).toEqual({ ai: { reviewStatus: 'ANY_NON_REJECTED' } });
    expect(compactCriteria({ tagMode: 'all' })).toEqual({});
  });

  it('round-trips through the URL and survives garbage', () => {
    const c = { text: 'robbery', location: { lat: 12.97, lon: 77.59, radiusKm: 1 }, ai: { labels: ['car'], colors: ['red'], reviewStatus: 'APPROVED' as const } };
    expect(decodeCriteria(encodeCriteria(c))).toEqual(c);
    expect(encodeCriteria({})).toBe('');
    expect(decodeCriteria('{not json')).toEqual({});
    expect(decodeCriteria('[1,2]')).toEqual({});
  });

  it('counts active filters and builds jump-to-moment links', () => {
    expect(countCriteria({ text: 'x', statuses: ['REGISTERED'], ai: { labels: ['car'], colors: ['red'], reviewStatus: 'APPROVED' } })).toBe(3);
    expect(momentLink('e1', 5000)).toBe('/evidence/e1?tab=playback&t=5000');
    expect(momentLink('e1', 0)).toBe('/evidence/e1?tab=playback&t=1');
  });
});
