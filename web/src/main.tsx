import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './index.css';
import App from './App';
import { ToastProvider } from './components/Toast';

// After a release the previous chunks are gone: a tab opened on the old version gets a 404 on its next page.
// Reload once to fetch the new index.html; the timestamp stops a loop if the chunk is really missing.
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('chunk-reload') ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('chunk-reload', String(Date.now()));
  } catch {
    // storage unavailable: reload anyway
  }
  e.preventDefault();
  window.location.reload();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => (err as { status?: number }).status !== 401 && count < 2,
      refetchOnWindowFocus: false,
      // live updates come through SSE; this is only a safety net
      refetchInterval: 60_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
