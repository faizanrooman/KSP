/**
 * ops:purge-demo-data — neutralise development / UAT fixtures in a NON-production database that is being promoted
 * (e.g. the staging database after UAT), so the production preflight passes. Design constraints:
 *
 *  * Evidence is never deleted or modified. It is immutable by design (evidence_guard trigger, Object Lock); demo
 *    evidence recorded during UAT stays, confined to the (deactivated) demo org units, and is reported. A database
 *    that must contain no demo evidence at all is rebuilt instead (db:migrate + db:seed --production + bootstrap).
 *  * REFUSED whenever any evidence (any status) exists in a non-demo org unit (a real station): such a database holds real data
 *    and is not a demo database. There is no override for this.
 *  * REFUSED on KSP_ENVIRONMENT=production unless --i-understand is given.
 *  * Dry-run by default: prints the plan; --execute applies it in ONE transaction with a DEMO_DATA_PURGED audit event.
 *
 * What it does: dev seed users are DISABLED (password replaced by a random hash, MFA cleared, sessions revoked, role
 * grants removed) — except `admin`, which keeps its role and gets a new one-time password (must change) if it still
 * has the dev password; dev seed org units are deactivated; integration systems using the synthetic `fixture` adapter
 * are disabled.
 */
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { hashSecret, randomToken, verifySecret } from '../crypto.js';
import { appendAudit, type AuditActor } from '../audit.js';
import { DEV_SEED_ORG_CODES, DEV_SEED_PASSWORD, DEV_SEED_USERNAMES } from '../preflight.js';

export interface DemoPurgePlan {
  environment: string;
  refused: string | null;
  realEvidence: { count: number; units: string[] };
  demoEvidence: number;
  usersToDisable: string[];
  adminPasswordReset: boolean;
  orgUnitsToDeactivate: string[];
  fixtureSystemsToDisable: string[];
}

export interface DemoPurgeResult extends DemoPurgePlan {
  executed: boolean;
  adminOneTimePassword: string | null;
}

export async function planDemoPurge(db: Database, cfg: Pick<AppConfig, 'KSP_ENVIRONMENT' | 'NODE_ENV'>, opts: { iUnderstand?: boolean } = {}): Promise<DemoPurgePlan> {
  const environment = cfg.KSP_ENVIRONMENT ?? (cfg.NODE_ENV === 'production' ? 'production' : cfg.NODE_ENV);
  const demo = [...DEV_SEED_ORG_CODES] as string[];
  const real = await db.selectFrom('evidence as e').innerJoin('org_units as o', 'o.id', 'e.org_unit_id')
    .select(['o.code', sql<number>`count(*)::int`.as('n')])
    .where('o.code', 'not in', demo)
    .groupBy('o.code').execute();
  const realCount = real.reduce((n, r) => n + r.n, 0);
  const demoEv = await db.selectFrom('evidence as e').innerJoin('org_units as o', 'o.id', 'e.org_unit_id').select(sql<number>`count(*)::int`.as('n')).where('o.code', 'in', demo).executeTakeFirstOrThrow();
  const users = await db.selectFrom('users').select(['username', 'status', 'password_hash']).where('username', 'in', [...DEV_SEED_USERNAMES]).execute();
  const admin = users.find((u) => u.username === 'admin');
  const adminDev = !!admin?.password_hash && (await verifySecret(admin.password_hash, DEV_SEED_PASSWORD).catch(() => false));
  const orgs = await db.selectFrom('org_units').select('code').where('code', 'in', demo).where('active', '=', true).execute();
  const fixtures = await db.selectFrom('integration_systems').select('code').where('adapter', '=', 'fixture').where('enabled', '=', true).execute();
  let refused: string | null = null;
  if (realCount > 0) refused = `evidence is registered in non-demo org units (${real.map((r) => `${r.code}: ${r.n}`).join(', ')}): this database holds real data; purge-demo-data only runs on demo databases`;
  else if (environment === 'production' && !opts.iUnderstand) refused = 'KSP_ENVIRONMENT=production: pass --i-understand to purge demo data here';
  return {
    environment, refused,
    realEvidence: { count: realCount, units: real.map((r) => r.code) },
    demoEvidence: demoEv.n,
    usersToDisable: users.filter((u) => u.username !== 'admin' && u.status !== 'DISABLED').map((u) => u.username),
    adminPasswordReset: adminDev,
    orgUnitsToDeactivate: orgs.map((o) => o.code),
    fixtureSystemsToDisable: fixtures.map((f) => f.code),
  };
}

export async function executeDemoPurge(db: Database, plan: DemoPurgePlan, actor: AuditActor): Promise<DemoPurgeResult> {
  if (plan.refused) throw new Error(`purge refused: ${plan.refused}`);
  let adminOneTimePassword: string | null = null;
  const scrambled = await hashSecret(randomToken(32));
  const adminHash = plan.adminPasswordReset ? await hashSecret((adminOneTimePassword = `${randomToken(12)}!Aa1`)) : null;
  await db.transaction().execute(async (tx) => {
    // Re-check the real-data gate inside the transaction (no evidence registered in the meantime).
    const again = await tx.selectFrom('evidence as e').innerJoin('org_units as o', 'o.id', 'e.org_unit_id').select(sql<number>`count(*)::int`.as('n'))
      .where('o.code', 'not in', [...DEV_SEED_ORG_CODES]).executeTakeFirstOrThrow();
    if (again.n > 0) throw new Error('purge refused: real evidence appeared while purging');
    if (plan.usersToDisable.length) {
      const ids = (await tx.selectFrom('users').select('id').where('username', 'in', plan.usersToDisable).execute()).map((u) => u.id);
      await tx.updateTable('users').set({
        status: 'DISABLED', disabled_at: new Date(), disabled_reason: 'demo data purged (ops:purge-demo-data)', password_hash: scrambled, must_change_password: true,
        mfa_enabled: false, mfa_secret_enc: null, mfa_pending_secret_enc: null, mfa_recovery_codes: [], mfa_enrolled_at: null,
      }).where('id', 'in', ids).execute();
      await tx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'demo data purged' }).where('user_id', 'in', ids).where('revoked_at', 'is', null).execute();
      await tx.deleteFrom('user_roles').where('user_id', 'in', ids).execute();
    }
    if (adminHash) {
      await tx.updateTable('users').set({ password_hash: adminHash, password_changed_at: new Date(), must_change_password: true }).where('username', '=', 'admin').execute();
      await tx.updateTable('sessions').set({ revoked_at: new Date(), revoke_reason: 'demo data purged' }).where('user_id', 'in', tx.selectFrom('users').select('id').where('username', '=', 'admin')).where('revoked_at', 'is', null).execute();
    }
    if (plan.orgUnitsToDeactivate.length) await tx.updateTable('org_units').set({ active: false }).where('code', 'in', plan.orgUnitsToDeactivate).execute();
    if (plan.fixtureSystemsToDisable.length) await tx.updateTable('integration_systems').set({ enabled: false, updated_at: new Date() }).where('code', 'in', plan.fixtureSystemsToDisable).execute();
    await appendAudit(tx, actor, {
      action: 'DEMO_DATA_PURGED', resourceType: 'database',
      details: { environment: plan.environment, usersDisabled: plan.usersToDisable, adminPasswordReset: plan.adminPasswordReset, orgUnitsDeactivated: plan.orgUnitsToDeactivate, fixtureSystemsDisabled: plan.fixtureSystemsToDisable, demoEvidenceRetained: plan.demoEvidence },
    });
  });
  return { ...plan, executed: true, adminOneTimePassword };
}
