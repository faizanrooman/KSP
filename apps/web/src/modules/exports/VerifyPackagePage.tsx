/** Verify a court export package (ZIP upload) or a manifest.json + manifest.sig pair. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { request, errorMessage } from '@/lib/api';
import { Alert, Badge, Button, Card, DataTable, Field, KeyValue, PageHeader, Tabs, type Column } from '@/components/ui';
import { shortHash } from '@/lib/format';
import type { VerificationReport } from './types';

const MAX = 100 * 1024 * 1024;
type Mode = 'package' | 'manifest';

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

export function VerifyPackagePage() {
  const [mode, setMode] = useState<Mode>('package');
  const [zip, setZip] = useState<File | null>(null);
  const [manifest, setManifest] = useState<File | null>(null);
  const [sig, setSig] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      if (mode === 'package') {
        if (!zip) throw new Error('Choose a ZIP package');
        if (zip.size > MAX) throw new Error('The package is larger than 100 MiB: verify it offline with the commands in VERIFY.txt, or upload manifest.json + manifest.sig');
        return request<VerificationReport>('POST', '/exports/verify', { raw: zip, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (!manifest || !sig) throw new Error('Choose manifest.json and manifest.sig');
      return request<VerificationReport>('POST', '/exports/verify', { body: { manifest: await manifest.text(), signature: toBase64(await sig.arrayBuffer()) } });
    },
  });
  const r = m.data;
  const cols: Column<NonNullable<VerificationReport['files']>[number]>[] = [
    { key: 'p', header: 'File', render: (f) => <span className="mono text-xs">{f.path}</span> },
    { key: 'e', header: 'Manifest SHA-256', render: (f) => <code className="mono text-xs">{shortHash(f.expectedSha256, 16)}</code> },
    { key: 'a', header: 'Computed SHA-256', render: (f) => <code className="mono text-xs">{shortHash(f.actualSha256, 16)}</code> },
    { key: 'ok', header: 'Result', render: (f) => (f.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">{f.problem ?? 'Mismatch'}</Badge>) },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Verify an export package" subtitle="Checks the digital signature against the KSP signing certificate, every file hash, and our records." breadcrumb={<Link to="/exports" className="text-brand-700 hover:underline">Court exports</Link>} />
      <Tabs tabs={[{ id: 'package' as Mode, label: 'Whole package (ZIP)' }, { id: 'manifest' as Mode, label: 'Manifest + signature' }]} value={mode} onChange={(v) => { setMode(v); m.reset(); }} />
      <Card>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          {mode === 'package' ? (
            <Field label="Export package (.zip, up to 100 MiB)" htmlFor="vp-zip"><input id="vp-zip" type="file" accept=".zip,application/zip" onChange={(e) => setZip(e.target.files?.[0] ?? null)} className="block text-sm" /></Field>
          ) : (
            <>
              <Field label="manifest.json" htmlFor="vp-m"><input id="vp-m" type="file" accept=".json,application/json" onChange={(e) => setManifest(e.target.files?.[0] ?? null)} className="block text-sm" /></Field>
              <Field label="manifest.sig" htmlFor="vp-s"><input id="vp-s" type="file" onChange={(e) => setSig(e.target.files?.[0] ?? null)} className="block text-sm" /></Field>
            </>
          )}
          <Button type="submit" icon={<ShieldCheck className="h-4 w-4" />} loading={m.isPending}>Verify</Button>
          {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
        </form>
      </Card>
      {r && (
        <>
          {r.ok ? <Alert tone="green" title="Package verified">Signature valid, all hashes match, and the export, items and ledger head are in our records.</Alert> : (
            <Alert tone="red" title="Verification failed">
              <ul className="list-disc pl-5">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </Alert>
          )}
          <Card title="Result">
            <KeyValue items={[
              { label: 'Signature', value: r.signatureValid ? <Badge tone="green">Valid</Badge> : <Badge tone="red">Invalid</Badge> },
              { label: 'Package certificate', value: r.packageCertificateMatches === null ? '—' : r.packageCertificateMatches ? 'KSP signing certificate' : <Badge tone="red">Unknown certificate</Badge> },
              { label: 'Export', value: r.export ? `${r.export.exportNumber} · ${r.export.known ? r.export.status : 'unknown'}${r.export.known && !r.export.manifestMatchesRecord ? ' · manifest differs from record' : ''}` : '—' },
              { label: 'Ledger head', value: r.ledgerHead ? `seq ${r.ledgerHead.seq} · ${r.ledgerHead.existsInLedger ? 'present in ledger' : 'NOT in ledger'}` : '—' },
              { label: 'manifest.json SHA-256', value: r.manifestSha256, mono: true },
              { label: 'Items', value: r.items.map((i) => `${i.evidenceNumber ?? '?'}: ${i.knownInRecords ? 'hash matches register' : 'NOT in register'}`).join('; ') },
            ]} />
          </Card>
          {r.files && <Card title="Files" bodyClassName="p-0"><DataTable caption="Package files" columns={cols} rows={r.files} rowKey={(f) => f.path} /></Card>}
        </>
      )}
    </div>
  );
}
