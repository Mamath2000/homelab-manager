import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Eye, MessageSquareOff, Pencil, Plus, Trash2, X } from 'lucide-react';
import { Badge, Button, ConfirmModal, IconGroup, Modal, Spinner } from './ui';
import { api, type LogIgnoreRule, type LogIgnoreRuleInput } from '../lib/api';
import { emptyRule, useIgnoreRules, type IgnoreRange as Range, type RuleDraft } from '../lib/logIgnores';
import { useMe } from '../lib/auth';
import { useToast } from '../lib/toast';

// Benign messages left out of the journals (homelab#379): nothing is deleted on the log server, the hub leaves the lines
// of the active rules out of the list, the histogram, the matrix and the counters. Everyone who reads the journals sees
// the rules and can read the lines again; only admins write them.

// the range the editor counts the lines of a rule being typed over: long enough to see whether it holds
const PREVIEW_FROM = '7d';

const names = (v: string) => [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
const fmt = (n: number | null) => (n === null ? '?' : n.toLocaleString('fr-FR'));
const scope = (r: Pick<LogIgnoreRuleInput, 'hostnames' | 'apps'>) =>
  [r.hostnames.length ? r.hostnames.join(', ') : 'tous les hôtes', r.apps.length ? r.apps.join(', ') : 'toutes les applications'].join(' · ');

// The reminder above the list: the rules in force and what they hid over the period, a way to read those lines again,
// and the lines of one rule when the page shows them.
export function IgnoreBar({ role, range, show, onShow, rule, onRule, onOpen }: { role: string; range: Range; show: boolean; onShow: (on: boolean) => void; rule: string; onRule: (id: string) => void; onOpen: () => void }) {
  const { data } = useIgnoreRules(role, range);
  const rules = data?.rules ?? [];
  const active = rules.filter((r) => r.enabled);
  const current = rule ? rules.find((r) => r.id === rule) : undefined;
  if (!rules.length && !rule) return null;
  const hidden = active.reduce((sum, r) => sum + (r.count ?? 0), 0);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={onOpen} className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-zinc-300 hover:text-zinc-100" title={active.map((r) => `${r.pattern} — ${r.comment}`).join('\n')}>
        <MessageSquareOff className="h-3 w-3" /> {active.length} message{active.length > 1 ? 's' : ''} ignoré{active.length > 1 ? 's' : ''}
        {!data?.countError && <> · {fmt(hidden)} ligne{hidden > 1 ? 's' : ''} sur la période</>}
      </button>
      {!rule && (
        <label className="inline-flex items-center gap-1.5 text-zinc-300">
          <input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} />
          Afficher les ignorés
        </label>
      )}
      {rule && (
        <button type="button" className="inline-flex min-w-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200 hover:text-amber-100" title="Revenir aux journaux sans les messages ignorés" onClick={() => onRule('')}>
          <span className="truncate">lignes de la règle « {current?.pattern ?? rule} »</span> <X className="h-3 w-3 shrink-0" />
        </button>
      )}
    </div>
  );
}

// The rules, their lines over the period of the page, and what can be done with each.
export function IgnoreRulesModal({ open, onClose, role, range, onRule, onEdit }: { open: boolean; onClose: () => void; role: string; range: Range; onRule: (id: string) => void; onEdit: (r: RuleDraft) => void }) {
  const { canManage } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useIgnoreRules(role, range);
  const [removing, setRemoving] = useState<LogIgnoreRule | null>(null);
  const done = (msg: string) => (toast.success(msg), void qc.invalidateQueries({ queryKey: ['logs'] }));
  const toggle = useMutation({
    mutationFn: (r: LogIgnoreRule) => api.updateLogIgnore(r.id, { pattern: r.pattern, regex: r.regex, hostnames: r.hostnames, apps: r.apps, comment: r.comment, enabled: !r.enabled, role: role || undefined }),
    onSuccess: (r) => done(r.enabled ? 'Règle activée' : 'Règle désactivée'),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteLogIgnore(id),
    onSuccess: () => (setRemoving(null), done('Règle supprimée')),
    onError: (e: Error) => toast.error(e.message),
  });
  const rules = data?.rules ?? [];
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        wide="xl"
        scroll
        title="Messages ignorés"
        footer={canManage ? <Button variant="primary" icon={Plus} onClick={() => onEdit(emptyRule)}>Nouvelle règle</Button> : undefined}
      >
        <p className="mb-3 text-xs text-muted">
          Les lignes d'une règle active sont écartées à la lecture (liste, histogramme, matrice, émetteurs, erreurs des hôtes) ; rien n'est supprimé sur le serveur.
          Le nombre de lignes est compté sur la période de la page{data?.countError ? ` (illisible : ${data.countError})` : ''}.
        </p>
        {isLoading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : error ? (
          <p className="text-sm text-red-400">{(error as Error).message}</p>
        ) : !rules.length ? (
          <p className="py-6 text-center text-sm text-muted">Aucune règle. « Ignorer ce message » sur une ligne de la liste en crée une, pré-remplie.</p>
        ) : (
          <ul className="divide-y divide-line/60 rounded-md border border-line">
            {rules.map((r) => (
              <li key={r.id} className={clsx('flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2', !r.enabled && 'opacity-60')}>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge tone={r.regex ? 'info' : 'neutral'}>{r.regex ? 'regex' : 'texte'}</Badge>
                    {!r.enabled && <Badge tone="warn">désactivée</Badge>}
                    <code className="min-w-0 break-all font-mono text-xs text-zinc-200">{r.pattern}</code>
                  </div>
                  <div className="text-xs text-muted">{scope(r)}</div>
                  <div className="text-xs text-zinc-300">{r.comment}</div>
                  <div className="text-[11px] text-zinc-500">par {r.updatedBy ?? r.by ?? '—'}, le {new Date(r.updatedAt ?? r.at).toLocaleString('fr-FR')}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs tabular-nums text-zinc-300" title="Lignes de la règle sur la période">{fmt(r.count)} ligne{(r.count ?? 0) > 1 ? 's' : ''}</span>
                  <IconGroup
                    actions={[
                      { icon: Eye, title: 'Voir ses lignes', onClick: () => (onRule(r.id), onClose()) },
                      ...(canManage
                        ? [
                            { icon: MessageSquareOff, title: r.enabled ? 'Désactiver (ses lignes réapparaissent)' : 'Activer', onClick: () => toggle.mutate(r), loading: toggle.isPending && toggle.variables?.id === r.id, iconClass: r.enabled ? 'text-emerald-400' : undefined },
                            { icon: Pencil, title: 'Modifier', onClick: () => onEdit(r) },
                            { icon: Trash2, title: 'Supprimer', onClick: () => setRemoving(r), danger: true },
                          ]
                        : []),
                    ]}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id)} loading={remove.isPending} danger title="Supprimer la règle" confirmLabel="Supprimer">
        <p>Les lignes de « <code className="font-mono">{removing?.pattern}</code> » réapparaîtront dans les journaux. Désactiver la règle les fait réapparaître aussi, en la gardant.</p>
      </ConfirmModal>
    </>
  );
}

// Creates or changes a rule; what it would hide is counted while it is typed (and the server says whether it reads it).
export function IgnoreRuleEditor({ initial, role, onClose }: { initial: RuleDraft; role: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState({ ...initial, hostnamesText: initial.hostnames.join(', '), appsText: initial.apps.join(', ') });
  const match = { pattern: d.pattern.trim(), regex: d.regex, hostnames: names(d.hostnamesText), apps: names(d.appsText) };
  // counted once the typing pauses
  const [counted, setCounted] = useState(match);
  const key = JSON.stringify(match);
  useEffect(() => {
    const t = setTimeout(() => setCounted(JSON.parse(key) as typeof match), 600);
    return () => clearTimeout(t);
  }, [key]);
  const preview = useQuery({
    queryKey: ['logs', 'ignore-preview', role, counted],
    queryFn: () => api.previewLogIgnore({ ...counted, role: role || undefined, from: PREVIEW_FROM }),
    enabled: !!counted.pattern,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...match, comment: d.comment.trim(), enabled: d.enabled, role: role || undefined };
      return d.id ? api.updateLogIgnore(d.id, body) : api.createLogIgnore(body);
    },
    onSuccess: () => (toast.success(d.id ? 'Règle modifiée' : 'Message ignoré'), void qc.invalidateQueries({ queryKey: ['logs'] }), onClose()),
    onError: (e: Error) => toast.error(e.message),
  });
  const field = 'mb-1 block text-xs text-muted';
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={d.id ? 'Modifier la règle' : 'Ignorer un message'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" loading={save.isPending} disabled={!match.pattern || !d.comment.trim()} onClick={() => save.mutate()}>{d.id ? 'Enregistrer' : 'Ignorer'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className={field}>Motif</span>
          <textarea className="input min-h-[4.5rem] w-full font-mono text-xs" value={d.pattern} onChange={(e) => setD({ ...d, pattern: e.target.value })} spellCheck={false} autoFocus />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={d.regex} onChange={(e) => setD({ ...d, regex: e.target.checked })} />
          Expression régulière (syntaxe RE2)
        </label>
        <p className="text-xs text-muted">
          {d.regex
            ? <>Une date, une heure ou un numéro qui change d'une ligne à l'autre : <code className="font-mono">\d+</code>. Éviter <code className="font-mono">(?i)</code> : sans la casse, le serveur relit toutes les lignes (lent).</>
            : <>Texte cherché tel qu'il est écrit, casse comprise, n'importe où dans le message.</>}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={field}>Hôtes (noms bruts, séparés par des virgules ; vide : tous)</span>
            <input className="input w-full font-mono text-xs" value={d.hostnamesText} onChange={(e) => setD({ ...d, hostnamesText: e.target.value })} placeholder="pve1, pve2" spellCheck={false} />
          </label>
          <label className="block min-w-0">
            <span className={field}>Applications (vide : toutes)</span>
            <input className="input w-full font-mono text-xs" value={d.appsText} onChange={(e) => setD({ ...d, appsText: e.target.value })} placeholder="kernel" spellCheck={false} />
          </label>
        </div>
        <label className="block">
          <span className={field}>Pourquoi ce message est-il bénin ?</span>
          <textarea className="input min-h-[3.5rem] w-full text-sm" value={d.comment} onChange={(e) => setD({ ...d, comment: e.target.value })} maxLength={500} />
        </label>
        <div className={clsx('rounded-md border border-line p-3 text-xs', preview.isPlaceholderData && 'opacity-60')}>
          {!match.pattern ? (
            <span className="text-muted">Saisir un motif pour voir les lignes qu'il écarterait.</span>
          ) : preview.isLoading ? (
            <Spinner />
          ) : preview.error ? (
            <span className="text-red-400">{(preview.error as Error).message}</span>
          ) : (
            <>
              <div className="mb-1.5 text-zinc-300">{fmt(preview.data?.count ?? 0)} ligne{(preview.data?.count ?? 0) > 1 ? 's' : ''} sur 7 jours{preview.data?.count ? ', les plus récentes :' : ' : le motif ne trouve rien, vérifier le texte (casse comprise) et la portée.'}</div>
              <ul className="space-y-0.5 font-mono">
                {preview.data?.rows.map((r, i) => (
                  <li key={`${r.time}:${i}`} className="truncate text-zinc-400" title={r.message}>
                    <span className="text-zinc-500">{new Date(r.time).toLocaleString('fr-FR')}</span> {r.hostname} {r.app}: <span className="text-zinc-200">{r.message}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
