import type { EvidenceTab } from '@/lib/extensions';
import { PlaybackTab, SnapshotsTab } from './tabs';

const tabs: EvidenceTab[] = [
  { id: 'playback', label: 'Playback', order: 10, anyOf: ['evidence:play'], component: PlaybackTab },
  { id: 'snapshots', label: 'Snapshots', order: 20, anyOf: ['evidence:play'], component: SnapshotsTab },
];
export default tabs;
