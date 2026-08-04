export const CREATION_INTAKE_STORAGE_KEY = 'combo:landing-kol-source:v1';

export interface LandingDraft {
  version: 1;
  mode: 'kol_profile';
  profileUrl: string;
  contactEmail?: string;
  consent: true;
  sampleText?: string;
  preparedAt: string;
}

export interface LandingDraftInput {
  profileUrl: string;
  contactEmail?: string;
  consent: true;
  sampleText?: string;
}

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;
type StorageRemover = Pick<Storage, 'removeItem'>;

export type SaveLandingDraftResult =
  | { ok: true; value: LandingDraft }
  | { ok: false; reason: 'invalid' | 'unavailable' };

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function normalizePublicProfileUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2_048) return null;

  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === 'http:' || url.protocol === 'https:';
    const allowedPort = !url.port || url.port === '80' || url.port === '443';
    if (!allowedProtocol || !allowedPort || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeContactEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

function parseLandingDraft(value: unknown): LandingDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<LandingDraft>;
  const profileUrl =
    typeof draft.profileUrl === 'string' ? normalizePublicProfileUrl(draft.profileUrl) : null;
  const sampleText = typeof draft.sampleText === 'string' ? draft.sampleText.trim() : undefined;
  const contactEmail =
    typeof draft.contactEmail === 'string' ? normalizeContactEmail(draft.contactEmail) : undefined;
  const preparedAt =
    typeof draft.preparedAt === 'string' && !Number.isNaN(Date.parse(draft.preparedAt))
      ? draft.preparedAt
      : null;

  if (
    draft.version !== 1 ||
    draft.mode !== 'kol_profile' ||
    draft.consent !== true ||
    !profileUrl ||
    !preparedAt ||
    (typeof draft.contactEmail === 'string' && !contactEmail) ||
    (sampleText !== undefined && (sampleText.length < 20 || sampleText.length > 20_000))
  ) {
    return null;
  }

  return {
    version: 1,
    mode: 'kol_profile',
    profileUrl,
    ...(contactEmail ? { contactEmail } : {}),
    consent: true,
    ...(sampleText ? { sampleText } : {}),
    preparedAt,
  };
}

export function saveLandingDraft(
  input: LandingDraftInput,
  storage: StorageWriter | null = browserSessionStorage(),
): SaveLandingDraftResult {
  const profileUrl = normalizePublicProfileUrl(input.profileUrl);
  const contactEmail = input.contactEmail?.trim()
    ? normalizeContactEmail(input.contactEmail)
    : undefined;
  const sampleText = input.sampleText?.trim();
  if (
    !profileUrl ||
    (input.contactEmail?.trim() ? !contactEmail : false) ||
    input.consent !== true ||
    (sampleText !== undefined &&
      sampleText !== '' &&
      (sampleText.length < 20 || sampleText.length > 20_000))
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const value: LandingDraft = {
    version: 1,
    mode: 'kol_profile',
    profileUrl,
    ...(contactEmail ? { contactEmail } : {}),
    consent: true,
    ...(sampleText ? { sampleText } : {}),
    preparedAt: new Date().toISOString(),
  };

  if (!storage) return { ok: false, reason: 'unavailable' };
  try {
    storage.setItem(CREATION_INTAKE_STORAGE_KEY, JSON.stringify(value));
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export function readLandingDraft(
  storage: StorageReader | null = browserSessionStorage(),
): LandingDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CREATION_INTAKE_STORAGE_KEY);
    if (!raw) return null;
    return parseLandingDraft(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function clearLandingDraft(
  storage: StorageRemover | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(CREATION_INTAKE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
