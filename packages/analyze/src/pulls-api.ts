import type { PullInfo } from './pull-store';

// What /api/pulls answers: the pulls on disk, a pull in progress, and the one being analyzed.
export interface PullsResponse {
  pulls: (Omit<PullInfo, 'at'> & { at: string })[];
  pulling: { running: boolean; lines: string[]; error?: string };
  open?: { stamp?: string; label: string; savedAt: string };
}
