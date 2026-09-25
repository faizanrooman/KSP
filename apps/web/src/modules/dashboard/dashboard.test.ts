import { describe, expect, it } from 'vitest';
import { ALERT_RULE_CODES } from '@ksp/shared';
import dashboardModule from './module';
import alertsModule from '../alerts/module';
import { RULE_FIELDS } from '../alerts/api';
import { SERIES, STATUS } from './charts';

describe('ops web modules', () => {
  it('uses the validated categorical slots and a distinct status palette', () => {
    expect(SERIES).toEqual(['#2a78d6', '#eb6834', '#1baf7a']);
    expect(Object.values(STATUS)).not.toContain(SERIES[1]);
  });

  it('dashboard owns the root route and is first in Overview', () => {
    expect(dashboardModule.routes.map((r) => r.path)).toContain('');
    expect(dashboardModule.nav?.[0]).toMatchObject({ to: '/', section: 'Overview', order: 0 });
    expect(alertsModule.routes.map((r) => r.path)).toEqual(expect.arrayContaining(['alerts', 'alerts/rules', 'alerts/:id', 'notifications']));
  });

  it('rule threshold editors only reference real rule codes', () => {
    for (const code of Object.keys(RULE_FIELDS)) expect(ALERT_RULE_CODES as readonly string[]).toContain(code);
  });
});
