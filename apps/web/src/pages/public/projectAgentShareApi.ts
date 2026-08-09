import {
  ProjectAgentShareResultSchema,
  ProjectAgentShareTokenSchema,
  type ProjectAgentShareResult,
} from '@cb/shared';
import { apiGet } from '../../api/client.js';

export async function fetchProjectAgentShare(shareToken: string): Promise<ProjectAgentShareResult> {
  const token = ProjectAgentShareTokenSchema.parse(shareToken);
  const result = ProjectAgentShareResultSchema.parse(
    await apiGet<unknown>(`/project-agent-shares/${encodeURIComponent(token)}`),
  );
  const expectedShareUrl = new URL(`/project-agent/${token}`, window.location.origin).toString();
  if (result.shareUrl !== expectedShareUrl) {
    throw new Error('Project Agent share response does not match the requested public link.');
  }
  return result;
}
