import type { WebModule } from '@/lib/modules';

/** Chain of custody contributes an evidence tab (evidence-tabs.tsx); it has no pages of its own. */
const mod: WebModule = { id: 'custody', routes: [] };
export default mod;
