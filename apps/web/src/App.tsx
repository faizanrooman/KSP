import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ComponentType } from 'react';
import type { Permission } from '@ksp/shared';
import { useAuth } from '@/lib/auth';
import { MODULES } from '@/lib/modules';
import { AppShell } from '@/components/AppShell';
import { Spinner } from '@/components/ui';
import { ChangePasswordPage, LoginPage, MfaEnrollPanel } from '@/pages/AuthPages';
import { ForbiddenPage, NotFoundPage } from '@/pages/StatusPages';

function Guard({ element: El, anyOf }: { element: ComponentType; anyOf?: Permission[] }) {
  const { canAny } = useAuth();
  if (anyOf && anyOf.length && !canAny(...anyOf)) return <ForbiddenPage />;
  return <El />;
}

export default function App() {
  const { me, loading } = useAuth();
  const location = useLocation();
  const publicRoutes = MODULES.flatMap((m) => m.publicRoutes ?? []);
  const routes = MODULES.flatMap((m) => m.routes);
  const hasRoot = routes.some((r) => r.path === '' || r.path === '/');

  return (
    <Routes>
      {publicRoutes.map((r) => (
        <Route key={r.path} path={r.path} element={<r.element />} />
      ))}
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="*"
        element={
          loading ? (
            <Spinner label="Loading session…" className="min-h-screen" />
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
