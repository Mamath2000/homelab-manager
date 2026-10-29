import { lazy, useEffect, type ComponentType } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { api, type Me } from './lib/api';
import { MeContext, rights } from './lib/auth';
import { useLiveEvents } from './lib/live';
import { ForcePasswordChange, Login } from './pages/Login';

// One chunk per page, fetched on first visit (Login stays in the main bundle: shown before the Layout).
// Pages use named exports, lazy() wants a default one.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Accounts = page(() => import('./pages/Accounts'), 'Accounts');
const Activity = page(() => import('./pages/Activity'), 'Activity');
const Backups = page(() => import('./pages/Backups'), 'Backups');
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard');
const Docker = page(() => import('./pages/Docker'), 'Docker');
const EquipmentDetail = page(() => import('./pages/EquipmentDetail'), 'EquipmentDetail');
const Equipments = page(() => import('./pages/Equipments'), 'Equipments');
const HostDetail = page(() => import('./pages/HostDetail'), 'HostDetail');
const Hosts = page(() => import('./pages/Hosts'), 'Hosts');
const Health = page(() => import('./pages/Health'), 'Health');
const Probes = page(() => import('./pages/Probes'), 'Probes');
const JobDetail = page(() => import('./pages/JobDetail'), 'JobDetail');
const Settings = page(() => import('./pages/Settings'), 'Settings');
const Stack = page(() => import('./pages/Stack'), 'Stack');
const Updates = page(() => import('./pages/Updates'), 'Updates');

export default function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus, staleTime: Infinity });
  const user = auth.data?.user ?? null;
  // the superadmin may only use the accounts page, not the live feed
  const live = useLiveEvents(!!user && user.profile !== 'superadmin' && !user.mustChangePassword);

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
        cookieSecure={!!auth.data!.cookieSecure}
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
                <Route path="equipments" element={<Equipments />} />
                <Route path="equipments/:id" element={<EquipmentDetail />} />
                <Route path="health" element={<Health />} />
                <Route path="probes" element={<Probes />} />
                <Route path="updates" element={<Updates />} />
                <Route path="docker" element={<Docker />} />
                <Route path="docker/:hostId/:stack" element={<Stack />} />
                <Route path="backups" element={<Backups />} />
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
