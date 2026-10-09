import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { api } from './lib/api';
import { useLiveEvents } from './lib/live';
import { Activity } from './pages/Activity';
import { Dashboard } from './pages/Dashboard';
import { HostDetail } from './pages/HostDetail';
import { Hosts } from './pages/Hosts';
import { JobDetail } from './pages/JobDetail';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { Updates } from './pages/Updates';

export default function App() {
  const qc = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.authStatus, staleTime: Infinity });
  const user = auth.data?.user?.username;
  const live = useLiveEvents(!!user);

  // Switch user state without detaching the ['auth'] observer (qc.clear() would).
  const setUser = (username: string | null) => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    qc.setQueryData(['auth'], { setupRequired: false, user: username ? { username } : null });
  };

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['auth'], { setupRequired: false, user: null });
    window.addEventListener('hm:unauthorized', onUnauthorized);
    return () => window.removeEventListener('hm:unauthorized', onUnauthorized);
  }, [qc]);

  if (auth.isLoading) return <div className="flex min-h-screen items-center justify-center"><Spinner /></div>;
  if (auth.isError) return <div className="flex min-h-screen items-center justify-center text-sm text-red-400">Hub injoignable : {auth.error.message}</div>;

  if (!user) {
    return (
      <Login
        setup={auth.data!.setupRequired}
        onDone={setUser}
      />
    );
  }

  const logout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout user={user} live={live} onLogout={logout} />}>
          <Route index element={<Dashboard />} />
          <Route path="hosts" element={<Hosts />} />
          <Route path="hosts/:id" element={<HostDetail />} />
          <Route path="updates" element={<Updates />} />
          <Route path="activity" element={<Activity />} />
          <Route path="jobs/:id" element={<JobDetail />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
