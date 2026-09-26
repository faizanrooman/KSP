import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import type { MeResponse } from '@ksp/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Field, Input } from '@/components/ui';

function AuthFrame({ title, children, subtitle, signOut }: { title: string; subtitle?: string; children: ReactNode; signOut?: boolean }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-950 via-brand-900 to-ink-900 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3 text-white">
          <ShieldCheck className="h-10 w-10 text-brand-300" aria-hidden />
          <div>
            <p className="text-lg font-semibold">Karnataka State Police</p>
            <p className="text-sm text-brand-200">Video Evidence Management System</p>
          </div>
        </div>
        <div className="card p-6">
          <h1 className="mb-1">{title}</h1>
          {subtitle && <p className="mb-4 text-sm text-ink-500">{subtitle}</p>}
          {children}
        </div>
        {signOut && (
          <p className="mt-4 text-center text-sm">
            <button
              type="button"
              className="text-brand-100 underline hover:text-white"
              onClick={async () => {
                await logout();
                navigate('/login', { replace: true });
              }}
            >
              Sign out
            </button>
          </p>
        )}
        <p className="mt-4 text-center text-xs text-brand-200">
          This system is for authorised police personnel only. Access and activity are logged and monitored.
        </p>
      </div>
    </main>
  );
}

export function LoginPage() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (location.state as { from?: string } | null)?.from ?? '/';

  const finish = (me: MeResponse) => {
    setMe(me);
    navigate(next, { replace: true });
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ me?: MeResponse; mfaRequired?: boolean; mfaToken?: string }>('/auth/login', { username, password }, { noRefresh: true });
      if (r.mfaRequired && r.mfaToken) setMfaToken(r.mfaToken);
      else if (r.me) finish(r.me);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = useRecovery ? { mfaToken, recoveryCode: code.trim() } : { mfaToken, code: code.trim() };
      const r = await api.post<{ me: MeResponse }>('/auth/mfa/verify', body, { noRefresh: true });
      finish(r.me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && /token/i.test(err.message)) setMfaToken(null);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setCode('');
    }
  };

  if (mfaToken) {
    return (
      <AuthFrame title="Two-step verification" subtitle={useRecovery ? 'Enter one of your one-time recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}>
        <form onSubmit={submitCode} className="space-y-4">
          {error && <Alert tone="red">{error}</Alert>}
          <Field label={useRecovery ? 'Recovery code' : 'Verification code'} htmlFor="code" required>
            <Input id="code" autoFocus autoComplete="one-time-code" inputMode={useRecovery ? 'text' : 'numeric'} pattern={useRecovery ? undefined : '\\d{6}'} maxLength={useRecovery ? 32 : 6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Verify
          </Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="text-brand-700 hover:underline" onClick={() => setUseRecovery((v) => !v)}>
              {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
            </button>
            <button type="button" className="text-ink-500 hover:underline" onClick={() => setMfaToken(null)}>
              Back
            </button>
          </div>
        </form>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign in">
      <form onSubmit={submitPassword} className="space-y-4">
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Username" htmlFor="username" required>
          <Input id="username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password" required>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const { refresh } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('New passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password/change', { currentPassword: current, newPassword: next });
      setDone(true);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const form = (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="red">{error}</Alert>}
      {done && <Alert tone="green">Password changed. Other sessions have been signed out.</Alert>}
      <Field label="Current password" htmlFor="cur" required>
        <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" htmlFor="new" required hint="At least 12 characters with upper- and lower-case letters, a digit and a symbol. Must differ from recent passwords.">
        <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </Field>
      <Field label="Confirm new password" htmlFor="conf" required>
        <Input id="conf" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <Button type="submit" loading={busy}>
        Change password
      </Button>
    </form>
  );
  return forced ? (
    <AuthFrame title="Change your password" subtitle="Your password must be changed before you can continue." signOut>
      {form}
    </AuthFrame>
  ) : (
    form
  );
}

export function MfaEnrollPanel({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.post('/auth/mfa/setup'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirmCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { code: code.trim() });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const body = codes ? (
    <div className="space-y-4">
      <Alert tone="green" title="Two-step verification enabled">
        Save these one-time recovery codes somewhere safe. Each can be used once if you lose your authenticator. They will not be shown again.
      </Alert>
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-md bg-ink-50 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button
        onClick={async () => {
          await refresh();
          onDone?.();
        }}
      >
        I have saved my recovery codes
      </Button>
    </div>
  ) : setup ? (
    <form onSubmit={confirmCode} className="space-y-4">
      {error && <Alert tone="red">{error}</Alert>}
      <p className="text-sm text-ink-600">Scan this QR code with an authenticator app (e.g. Google Authenticator, Microsoft Authenticator), then enter the 6-digit code it shows.</p>
      <img src={setup.qrDataUrl} alt="QR code for authenticator enrolment" className="mx-auto h-48 w-48" />
      <p className="text-center text-xs text-ink-500">
        Manual entry key: <span className="mono select-all" data-testid="mfa-secret">{setup.secret}</span>
      </p>
      <Field label="Verification code" htmlFor="mfa-code" required>
        <Input id="mfa-code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
      </Field>
      <Button type="submit" loading={busy}>
        Verify and enable
      </Button>
    </form>
  ) : (
    <div className="space-y-4">
      {error && <Alert tone="red">{error}</Alert>}
      <p className="text-sm text-ink-600">Two-step verification protects your account with a time-based code from an authenticator app in addition to your password.</p>
      <Button onClick={start} loading={busy}>
        Set up authenticator
      </Button>
    </div>
  );
  return forced ? (
    <AuthFrame title="Set up two-step verification" subtitle="Your role requires multi-factor authentication." signOut>
      {body}
    </AuthFrame>
  ) : (
    body
  );
}
