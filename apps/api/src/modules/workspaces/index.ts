/**
 * Investigation workspace (spec module 11): workspaces, members, evidence items with sync offsets, bookmarks,
 * annotations, incident timeline and evidence relations. Permission `workspace:use`. A workspace NEVER grants
 * evidence access — see ./access.ts and docs/INVESTIGATION.md.
 */
import type { FastifyInstance } from 'fastify';
import workspaceRoutes from './workspace-routes.js';
import notesRoutes from './notes-routes.js';
import timelineRoutes from './timeline.js';

export const prefix = '/workspaces';

export default async function workspaces(app: FastifyInstance) {
  await app.register(notesRoutes);
  await app.register(workspaceRoutes);
  await app.register(timelineRoutes);
}
