import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// Agent server address, pinned keys and the upgrade / uninstall commands built by the hub.
export function useAgentTls() {
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });
  return data?.tls;
}
