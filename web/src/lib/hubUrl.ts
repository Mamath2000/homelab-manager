import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// Hub URL for commands shown in the UI: the agent settings, else this browser's address.
export function useHubUrl() {
  const { data } = useQuery({ queryKey: ['settings', 'agents'], queryFn: api.agentSettings });
  return data?.hubUrl || window.location.origin;
}
