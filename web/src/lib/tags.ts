import type { TagColor } from './api';

// Tailwind needs the full class names: one entry per colour of the catalog.
export const tagChip: Record<TagColor, string> = {
  zinc: 'bg-zinc-500/15 text-zinc-200 ring-zinc-500/30',
  red: 'bg-red-500/15 text-red-200 ring-red-500/30',
  orange: 'bg-orange-500/15 text-orange-200 ring-orange-500/30',
  amber: 'bg-amber-500/15 text-amber-200 ring-amber-500/30',
  lime: 'bg-lime-500/15 text-lime-200 ring-lime-500/30',
  emerald: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
  teal: 'bg-teal-500/15 text-teal-200 ring-teal-500/30',
  sky: 'bg-sky-500/15 text-sky-200 ring-sky-500/30',
  blue: 'bg-blue-500/15 text-blue-200 ring-blue-500/30',
  violet: 'bg-violet-500/15 text-violet-200 ring-violet-500/30',
  pink: 'bg-pink-500/15 text-pink-200 ring-pink-500/30',
};

export const tagSwatch: Record<TagColor, string> = {
  zinc: 'bg-zinc-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  lime: 'bg-lime-500',
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};
