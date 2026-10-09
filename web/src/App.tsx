import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { api, type Me } from './lib/api';
import { MeContext, rights } from './lib/auth';
import { useLiveEvents } from './lib/live';
import { Accounts } from './pages/Accounts';
import { Activity } from './pages/Activity';
import { Dashboard } from './pages/Dashboard';
import { Docker } from './pages/Docker';
import { HostDetail } from './pages/HostDetail';
import { Hosts } from './pages/Hosts';
import { JobDetail } from './pages/JobDetail';
import { ForcePasswordChange, Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Stack } from './pages/Stack';
import { Updates } from './pages/Updates';

export default function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus, staleTime: Infinity });
  const user = auth.data?.user ?? null;
  // the superadmin may only use the accounts page, not the live feed
  const live = useLiveEvents(!!user && user.role !== 'superadmin' && !user.mustChangePassword);

  // Switch user state without detaching the ['auth'] observer (qc.clear() would).
  const setUser = (me: Me | null) => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    qc.setQueryData(['auth'], { noAccounts: false, user: me });
  };

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['auth'], { noAccounts: false, user: null });
    window.addEventListener('hm:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hm:unauthorized', onUnauthorized);
  }, [qc]);

  if (auth.isLoading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (auth.isError) return <div className="flex min-h-screen items-center justify-center text-sm text-red-400">Hub injoignable : {auth.error.message}</div>;

  if (!user) {
    return (
      <Login
        noAccounts={auth.data!.noAccounts}
        onDone={setUser}
      />
    );
  }

  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  if (user.mustChangePassword) {
    return <ForcePasswordChange me={user} onLogout={logout} onDone={() => setUser({ ...user, mustChangePassword: false })} />;
  }

  const me = rights(user);

  return (
    <MeContext.Provider value={me}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout live={live} onLogout={logout} />}>
            {me.isSuperAdmin ? (
              <>
                <Route path="accounts" element={<Accounts />} />
                <Route path="*" element={<Navigate to="/accounts" replace />} />
              </>
            ) : (
              <>
                <Route index element={<Dashboard />} />
                <Route path="hosts" element={<Hosts />} />
                <Route path="hosts/:id" element={<HostDetail />} />
                <Route path="updates" element={<Updates />} />
                <Route path="docker" element={<Docker />} />
                <Route path="docker/:hostId/:stack" element={<Stack />} />
                <Route path="activity" element={<Activity />} />
                <Route path="jobs/:id" element={<JobDetail />} />
                {me.canAccounts && <Route path="accounts" element={<Accounts />} />}
                {me.canSettings && <Route path="settings" element={<Settings />} />}
                <Route path="*" element={<Navigate to="/" replace />} />
              </>
            )}
          </Route>
        </Routes>
      </BrowserRouter>
    </MeContext.Provider>
  );
}
