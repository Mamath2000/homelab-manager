import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Modal } from './ui';
import { useHosts } from '../lib/queries';

export function HostQuickSwitch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const { data: hosts, isLoading, isError, error } = useHosts();
  const selectedRef = useRef<HTMLButtonElement>(null);

  const filteredHosts = useMemo(() => {
    const name = query.trim().toLocaleLowerCase();
    return (hosts ?? [])
      .filter((host) => host.name.toLocaleLowerCase().includes(name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [hosts, query]);
  const activeIndex = Math.min(selectedIndex, Math.max(filteredHosts.length - 1, 0));
  const selectedHost = filteredHosts[activeIndex];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        setQuery('');
        setSelectedIndex(0);
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedIndex]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  };

  const selectHost = () => {
    if (!selectedHost) return;
    close();
    navigate(`/hosts/${selectedHost.id}`);
  };

  return (
    <Modal open={open} onClose={close} title="Accéder à un hôte">
      <div className="space-y-3">
        <input
          autoFocus
          className="input"
          placeholder="Filtrer par nom…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (filteredHosts.length) {
                setSelectedIndex(Math.min(activeIndex + 1, filteredHosts.length - 1));
              }
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex(Math.max(activeIndex - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              selectHost();
            }
          }}
          role="combobox"
          aria-label="Filtrer les hôtes par nom"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="host-quick-switch-list"
          aria-activedescendant={selectedHost ? `host-quick-switch-${selectedHost.id}` : undefined}
        />

        <div
          id="host-quick-switch-list"
          role="listbox"
          aria-label="Hôtes"
          className="max-h-72 overflow-y-auto rounded-md border border-line"
        >
          {isLoading ? (
            <p className="px-3 py-4 text-sm text-muted">Chargement des hôtes…</p>
          ) : isError ? (
            <p role="alert" className="px-3 py-4 text-sm text-red-400">
              Impossible de charger les hôtes : {error instanceof Error ? error.message : 'erreur inconnue'}
            </p>
          ) : filteredHosts.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted">
              {hosts?.length ? 'Aucun hôte ne correspond.' : 'Aucun hôte disponible.'}
            </p>
          ) : (
            filteredHosts.map((host, index) => (
              <button
                key={host.id}
                id={`host-quick-switch-${host.id}`}
                ref={index === activeIndex ? selectedRef : undefined}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => {
                  setSelectedIndex(index);
                  close();
                  navigate(`/hosts/${host.id}`);
                }}
                className={`block w-full px-3 py-2 text-left text-sm ${
                  index === activeIndex ? 'bg-emerald-500/15 text-emerald-200' : 'text-zinc-200 hover:bg-raised'
                }`}
              >
                {host.name}
              </button>
            ))
          )}
        </div>

        <p className="text-xs text-muted">↑ ↓ pour naviguer · Entrée pour ouvrir · Échap pour fermer</p>
      </div>
    </Modal>
  );
}
