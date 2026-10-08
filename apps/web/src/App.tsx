import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { ComponentType } from 'react';
import type { Permission } from '@ksp/shared';
import { useAuth } from '@/lib/auth';
import { LazyBoundary } from '@/lib/lazy';
import { MODULES } from '@/lib/modules';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui';
import { ChangePasswordPage, LoginPage, MfaEnrollPanel } from '@/pages/AuthPages';
import { ForbiddenPage, NotFoundPage } from '@/pages/StatusPages';

import { t } from '@/lib/i18n';
function Guard({ element: El, anyOf }: { element: ComponentType; anyOf?: Permission[] }) {
  const { canAny } = useAuth();
  if (anyOf && anyOf.length && !canAny(...anyOf)) return <ForbiddenPage />;
  return (
    <LazyBoundary label={t('Loading page…')}>
      <El />
    </LazyBoundary>
  );
}

export default function App() {
  const { me, loading } = useAuth();
  const location = useLocation();
  const publicRoutes = MODULES.flatMap((m) => m.publicRoutes ?? []);
  const routes = MODULES.flatMap((m) => m.routes);
  const hasRoot = routes.some((r) => r.path === '' || r.path === '/');
  // Where to go after signing in: the page that sent us to /login (router state, set by this app only). React
  // Router 7 applies navigate() in a transition, so the /login route itself must honour it once `me` is set.
  const from = (location.state as { from?: unknown } | null)?.from;
  const afterLogin = typeof from === 'string' && /^\/(?![/\\])/.test(from) ? from : '/';

  return (
    <Routes>
      {publicRoutes.map((r) => (
        <Route key={r.path} path={r.path} element={<LazyBoundary label={t('Loading…')} className="min-h-screen"><r.element /></LazyBoundary>} />
      ))}
      <Route path="/login" element={me ? <Navigate to={afterLogin} replace /> : <LoginPage />} />
      <Route
        path="*"
        element={
          loading ? (
            <Spinner label={t('Loading session…')} className="min-h-screen" />
          ) : !me ? (
            <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
          ) : me.user.mustChangePassword ? (
            <ChangePasswordPage forced />
          ) : me.user.mfaEnrollmentRequired ? (
            <MfaEnrollPanel forced />
          ) : (
            <AppShell>
              <Routes>
                {routes.map((r) => (
                  <Route key={r.path} path={r.path} element={<Guard element={r.element} anyOf={r.anyOf} />} />
                ))}
                {!hasRoot && <Route path="/" element={<Navigate to="/profile" replace />} />}
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </AppShell>
          )
        }
      />
    </Routes>
  );
}
