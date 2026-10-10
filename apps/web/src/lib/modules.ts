/**
 * Frontend module registry. Each feature lives in src/modules/<name>/module.tsx and default-exports a
 * WebModule. Modules are discovered automatically — no shared route file to edit. Route elements are lazy
 * (`lazyPage` in ./lazy.tsx): module.tsx files are metadata, their pages are separate chunks.
 */
import type { ComponentType } from 'react';
import type { Permission } from '@ksp/shared';

export type NavSection = 'Overview' | 'Evidence' | 'Analysis' | 'Investigation' | 'Cases' | 'Sharing & Export' | 'Compliance' | 'Administration';
export const NAV_SECTIONS: NavSection[] = ['Overview', 'Evidence', 'Analysis', 'Investigation', 'Cases', 'Sharing & Export', 'Compliance', 'Administration'];

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  section: NavSection;
  /** Show when the user has ANY of these permissions (omit = all authenticated users). */
  anyOf?: Permission[];
  /** Hide when the user has ANY of these permissions (an alternative entry covers them). */
  noneOf?: Permission[];
  order?: number;
}

export interface ModuleRoute {
  path: string; // relative to app root, e.g. 'evidence/:id'
  element: ComponentType;
  /** Require ANY of these permissions, otherwise a 403 page is shown. */
  anyOf?: Permission[];
}

export interface WebModule {
  id: string;
  routes: ModuleRoute[];
  nav?: NavItem[];
  /** Public routes rendered without the app shell/auth (e.g. external share portal). */
  publicRoutes?: ModuleRoute[];
}

const found = import.meta.glob<{ default: WebModule }>('../modules/*/module.tsx', { eager: true });
export const MODULES: WebModule[] = Object.values(found)
  .map((m) => m.default)
  .sort((a, b) => a.id.localeCompare(b.id));
