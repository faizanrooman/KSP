import { UserCircle2 } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { ProfilePage } from './ProfilePage';

const mod: WebModule = {
  id: 'profile',
  routes: [{ path: 'profile', element: ProfilePage }],
  nav: [{ to: '/profile', label: 'My profile', icon: UserCircle2, section: 'Administration', order: 999 }],
};
export default mod;
