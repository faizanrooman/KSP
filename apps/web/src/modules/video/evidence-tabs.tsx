import type { EvidenceTab } from '@/lib/extensions';
import { lazyPage } from '@/lib/lazy';

const PlaybackTab = lazyPage(() => import('./tabs'), 'PlaybackTab');
const SnapshotsTab = lazyPage(() => import('./tabs'), 'SnapshotsTab');

const tabs: EvidenceTab[] = [
  { id: 'playback', label: 'Playback', order: 10, anyOf: ['evidence:play'], component: PlaybackTab },
  { id: 'snapshots', label: 'Snapshots', order: 20, anyOf: ['evidence:play'], component: SnapshotsTab },
];
export default tabs;
