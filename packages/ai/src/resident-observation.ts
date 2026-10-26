import { converse } from './conversation';
import type { Options } from './conversation-types';
import { noticePeers } from './relationships';
import { learnWork } from './strategy-learning';

export function observeResident(options: Options) {
  const { session, checkpoint, template, peers } = options;
  learnWork(session, checkpoint, template);
  noticePeers(session, checkpoint, peers, template.behavior.sociability);
  void converse(options);
}
