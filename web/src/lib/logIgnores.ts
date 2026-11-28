import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type LogIgnoreRuleInput, type LogQuery } from './api';

// Benign messages left out of the journals (homelab#379): the rules as the page reads them (components/LogIgnoreRules.tsx).

export type IgnoreRange = Pick<LogQuery, 'from' | 'to'>;
export type RuleDraft = LogIgnoreRuleInput & { id?: string };

export const emptyRule: RuleDraft = { pattern: '', regex: false, hostnames: [], apps: [], comment: '', enabled: true };

// the rules with their lines over the range of the page
export const useIgnoreRules = (role: string, range: IgnoreRange) =>
  useQuery({ queryKey: ['logs', 'ignore-rules', role, range], queryFn: () => api.logIgnoreRules({ role: role || undefined, ...range }), placeholderData: keepPreviousData });
