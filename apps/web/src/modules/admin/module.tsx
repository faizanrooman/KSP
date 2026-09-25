import { Building2, Camera, Settings, ShieldCheck, Users } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { UsersListPage } from './UsersListPage';
import { UserCreatePage } from './UserCreatePage';
import { UserDetailPage } from './UserDetailPage';
import { RoleDetailPage, RolesListPage } from './RolesPage';
import { OrgUnitsPage } from './OrgUnitsPage';
import { DeviceDetailPage, DevicesPage } from './DevicesPage';
import { SettingsPage } from './SettingsPage';

const mod: WebModule = {
  id: 'admin',
  routes: [
    { path: 'admin/users', element: UsersListPage, anyOf: ['users:read', 'users:manage'] },
    { path: 'admin/users/new', element: UserCreatePage, anyOf: ['users:manage'] },
    { path: 'admin/users/:id', element: UserDetailPage, anyOf: ['users:read', 'users:manage', 'roles:manage'] },
    { path: 'admin/roles', element: RolesListPage, anyOf: ['roles:read'] },
    { path: 'admin/roles/:id', element: RoleDetailPage, anyOf: ['roles:read'] },
    { path: 'admin/org', element: OrgUnitsPage, anyOf: ['org:read'] },
    { path: 'admin/devices', element: DevicesPage, anyOf: ['devices:read'] },
    { path: 'admin/devices/:id', element: DeviceDetailPage, anyOf: ['devices:read'] },
    { path: 'admin/settings', element: SettingsPage, anyOf: ['settings:manage'] },
  ],
  nav: [
    { to: '/admin/users', label: 'Users', icon: Users, section: 'Administration', anyOf: ['users:manage', 'roles:manage'], order: 10 },
    { to: '/admin/roles', label: 'Roles & permissions', icon: ShieldCheck, section: 'Administration', anyOf: ['roles:manage', 'roles:read'], order: 20 },
    { to: '/admin/org', label: 'Organisation units', icon: Building2, section: 'Administration', anyOf: ['org:manage'], order: 30 },
    { to: '/admin/devices', label: 'Devices', icon: Camera, section: 'Administration', anyOf: ['devices:manage', 'devices:read'], order: 40 },
    { to: '/admin/settings', label: 'System settings', icon: Settings, section: 'Administration', anyOf: ['settings:manage'], order: 50 },
  ],
};
export default mod;
