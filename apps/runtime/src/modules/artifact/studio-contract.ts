import { validateAgentMiniappHtml, type AgentMiniappHtmlValidation } from '@cb/shared';

export type StudioHtmlValidation = AgentMiniappHtmlValidation;

/** Runtime 保留原函数名；具体规则由共享契约统一提供给 Authoring 与 Runtime。 */
export const validateStudioHtml = validateAgentMiniappHtml;

export class StudioArtifactValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Studio HTML 未通过运行契约：${issues.join('；')}`);
    this.name = 'StudioArtifactValidationError';
    this.issues = issues;
  }
}
