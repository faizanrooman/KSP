#!/usr/bin/env node
/**
 * Create / verify the application buckets (idempotent). Run by the migrate job after migrations.
 *   node scripts/ops/ensure-buckets.mjs [--check]
 * WORM buckets (evidence, archive, longterm) must have versioning Enabled and Object Lock enabled; if an existing
 * bucket lacks Object Lock (it cannot be added later on most stores) the script FAILS instead of continuing.
 * --check only verifies (no creation). Exit 1 on any problem.
 */
import { GetBucketVersioningCommand, GetObjectLockConfigurationCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { loadConfig, Storage } from '@ksp/core';

const check = process.argv.includes('--check');
const cfg = loadConfig();
const st = new Storage();
if (!check) await st.ensureBuckets();

const problems = [];
for (const role of ['staging', 'evidence', 'archive', 'longterm', 'derived', 'exports', 'reports']) {
  const Bucket = st.bucket(role);
  const worm = ['evidence', 'archive', 'longterm'].includes(role);
  try {
    const v = await st.s3.send(new GetBucketVersioningCommand({ Bucket }));
    let lock = 'n/a';
    if (worm) {
      if (v.Status !== 'Enabled') problems.push(`${Bucket}: versioning is ${v.Status ?? 'off'} (must be Enabled)`);
      if (cfg.OBJECT_LOCK_MODE !== 'NONE') {
        const l = await st.s3.send(new GetObjectLockConfigurationCommand({ Bucket })).catch((e) => ({ error: e }));
        lock = l.ObjectLockConfiguration?.ObjectLockEnabled ?? `missing (${l.error?.name ?? 'none'})`;
        if (lock !== 'Enabled') problems.push(`${Bucket}: Object Lock not enabled — recreate the bucket with object lock`);
      }
    }
    console.log(`${Bucket.padEnd(28)} role=${role.padEnd(9)} versioning=${v.Status ?? 'off'} objectLock=${lock}`);
  } catch (e) {
    problems.push(`${Bucket}: ${e.name ?? ''} ${e.message}`);
  }
}

// Staging holds unregistered uploads only: expire abandoned multipart uploads (best effort; not every store supports it).
if (!check) {
  try {
    await st.s3.send(new PutBucketLifecycleConfigurationCommand({
      Bucket: st.bucket('staging'),
      LifecycleConfiguration: { Rules: [{ ID: 'ksp-abort-incomplete-mpu', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } }] },
    }));
    console.log('staging lifecycle: abort incomplete multipart uploads after 7 days');
  } catch (e) {
    console.log(`staging lifecycle: not applied (${e.name ?? e.message}) — configure on the object store`);
  }
}

if (problems.length) {
  for (const p of problems) console.error(`PROBLEM ${p}`);
  process.exit(1);
}
console.log('buckets OK');
