export const RELEASE_DRAFT_STORAGE_PREFIX = 'combo:agent-release:v1';

export type PricingModel = 'per-use' | 'cost-plus' | 'time-pass';
export type ReleaseVisibility = 'public' | 'unlisted';
export type ReleaseStep = 'pricing' | 'identity' | 'review' | 'success';

export interface ReleaseDraft {
  version: 1;
  capabilityId: string;
  agentName: string;
  agentSummary?: string;
  currentStep?: ReleaseStep;
  pricingModel?: PricingModel;
  priceYuan?: number;
  marginTarget?: number;
  durationDays?: 7 | 30 | 365;
  handle?: string;
  visibility: ReleaseVisibility;
  confirmed: boolean;
  completedAt?: string;
  updatedAt: string;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function releaseDraftStorageKey(capabilityId: string): string {
  return `${RELEASE_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(capabilityId)}`;
}

export function emptyReleaseDraft(capabilityId: string, agentName = '待发布 Agent'): ReleaseDraft {
  return {
    version: 1,
    capabilityId,
    agentName,
    visibility: 'public',
    confirmed: false,
    updatedAt: new Date().toISOString(),
  };
}

function validMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000;
}

export function isValidReleaseHandle(value: string): boolean {
  return value.length >= 3 && value.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function readReleaseDraft(
  capabilityId: string,
  agentName?: string,
  storage: ReadStorage | null = browserStorage(),
): ReleaseDraft {
  const fallback = emptyReleaseDraft(capabilityId, agentName);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(releaseDraftStorageKey(capabilityId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ReleaseDraft>;
    if (parsed.version !== 1 || parsed.capabilityId !== capabilityId) return fallback;
    const pricingModel =
      parsed.pricingModel === 'per-use' ||
      parsed.pricingModel === 'cost-plus' ||
      parsed.pricingModel === 'time-pass'
        ? parsed.pricingModel
        : undefined;
    const durationDays =
      parsed.durationDays === 7 || parsed.durationDays === 30 || parsed.durationDays === 365
        ? parsed.durationDays
        : undefined;
    return {
      version: 1,
      capabilityId,
      agentName:
        agentName?.trim() ||
        (typeof parsed.agentName === 'string' ? parsed.agentName : fallback.agentName),
      ...(typeof parsed.agentSummary === 'string' ? { agentSummary: parsed.agentSummary } : {}),
      ...(parsed.currentStep === 'pricing' ||
      parsed.currentStep === 'identity' ||
      parsed.currentStep === 'review' ||
      parsed.currentStep === 'success'
        ? { currentStep: parsed.currentStep }
        : {}),
      ...(pricingModel ? { pricingModel } : {}),
      ...(validMoney(parsed.priceYuan) ? { priceYuan: parsed.priceYuan } : {}),
      ...(typeof parsed.marginTarget === 'number' &&
      Number.isFinite(parsed.marginTarget) &&
      parsed.marginTarget >= 0 &&
      parsed.marginTarget <= 95
        ? { marginTarget: parsed.marginTarget }
        : {}),
      ...(durationDays ? { durationDays } : {}),
      ...(typeof parsed.handle === 'string' ? { handle: parsed.handle } : {}),
      visibility: parsed.visibility === 'unlisted' ? 'unlisted' : 'public',
      confirmed: parsed.confirmed === true,
      ...(typeof parsed.completedAt === 'string' ? { completedAt: parsed.completedAt } : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : fallback.updatedAt,
    };
  } catch {
    return fallback;
  }
}

export function saveReleaseDraft(
  draft: ReleaseDraft,
  storage: WriteStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      releaseDraftStorageKey(draft.capabilityId),
      JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

export function releasePath(capabilityId: string, step: ReleaseStep = 'pricing'): string {
  return `/capabilities/${encodeURIComponent(capabilityId)}/release/${step}`;
}

export function pricingLabel(draft: ReleaseDraft): string {
  if (draft.pricingModel === 'per-use') return `单次 ¥${(draft.priceYuan ?? 0).toFixed(2)}`;
  if (draft.pricingModel === 'cost-plus') {
    return `按成本加价 · ${draft.marginTarget ?? 0}% 目标毛利`;
  }
  if (draft.pricingModel === 'time-pass') {
    return `${draft.durationDays ?? 30} 天访问 · ¥${(draft.priceYuan ?? 0).toFixed(2)}`;
  }
  return '尚未设置';
}

export function isPricingComplete(draft: ReleaseDraft): boolean {
  const validPrice = (draft.priceYuan ?? 0) > 0 && (draft.priceYuan ?? 0) <= 100_000;
  if (draft.pricingModel === 'per-use') return validPrice;
  if (draft.pricingModel === 'cost-plus') {
    return (draft.marginTarget ?? 0) > 0 && (draft.marginTarget ?? 0) <= 95;
  }
  if (draft.pricingModel === 'time-pass') {
    return validPrice && draft.durationDays !== undefined;
  }
  return false;
}
