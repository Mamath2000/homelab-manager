// Shared test data (not a test file: node --test only runs *.test.ts).
import { ObjectId } from 'mongodb';
import type { DockerReport, HostDoc } from '../src/types.js';

// Host with Docker and the given report / registry check.
export function dockerHost(report: Partial<DockerReport>, updates?: HostDoc['dockerUpdates']): HostDoc {
  return {
    _id: new ObjectId(),
    name: 'docker1',
    createdAt: new Date(),
    capabilities: ['docker'],
    docker: { checkedAt: Date.now(), engine: '27.0', compose: '2.29', stacks: [], images: [], ...report },
    dockerUpdates: updates,
  };
}
