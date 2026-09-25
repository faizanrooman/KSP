import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MeResponse, Permission } from '@ksp/shared';
import { api, ApiError } from './api';

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  refresh: () => Promise<MeResponse | null>;
  setMe: (me: MeResponse | null) => void;
  logout: () => Promise<void>;
  can: (...perms: Permission[]) => boolean;
  canAny: (...perms: Permission[]) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const m = await api.get<MeResponse>('/auth/me');
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauth = () => {
      setMe(null);
      qc.clear();
    };
    window.addEventListener('ksp:unauthenticated', onUnauth);
    return () => window.removeEventListener('ksp:unauthenticated', onUnauth);
  }, [refresh, qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {}, { noRefresh: true });
    } finally {
      setMe(null);
      qc.clear();
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const set = new Set(me?.permissions ?? []);
    return {
      me,
      loading,
      refresh,
      setMe,
      logout,
      can: (...perms) => perms.every((p) => set.has(p)),
      canAny: (...perms) => perms.some((p) => set.has(p)),
    };
  }, [me, loading, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
