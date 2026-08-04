import { describe, expect, it } from 'vitest';
import {
  CREATION_INTAKE_STORAGE_KEY,
  clearLandingDraft,
  normalizeContactEmail,
  normalizePublicProfileUrl,
  readLandingDraft,
  saveLandingDraft,
} from './landingDraft.js';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('landingDraft', () => {
  it('只接受公开 http(s) URL，并移除不会提交给服务端的 hash', () => {
    expect(normalizePublicProfileUrl(' https://example.com/creator#works ')).toBe(
      'https://example.com/creator',
    );
    expect(normalizePublicProfileUrl('ftp://example.com/creator')).toBeNull();
    expect(normalizePublicProfileUrl('https://name:secret@example.com/creator')).toBeNull();
    expect(normalizePublicProfileUrl('https://example.com:444/creator')).toBeNull();
  });

  it('联系邮箱做轻量规范化，并拒绝明显无效值', () => {
    expect(normalizeContactEmail(' Creator@Example.COM ')).toBe('creator@example.com');
    expect(normalizeContactEmail('not-an-email')).toBeNull();
  });

  it('把经过校验的主页资料写入会话存储，并可按版本安全读回', () => {
    const storage = new MemoryStorage();
    const saved = saveLandingDraft(
      {
        profileUrl: 'https://example.com/creator',
        contactEmail: 'creator@example.com',
        consent: true,
        sampleText: '这是一段足够长的代表内容，用来帮助系统理解我的工作方式。',
      },
      storage,
    );

    expect(saved.ok).toBe(true);
    expect(storage.values.has(CREATION_INTAKE_STORAGE_KEY)).toBe(true);
    expect(readLandingDraft(storage)).toMatchObject({
      version: 1,
      mode: 'kol_profile',
      profileUrl: 'https://example.com/creator',
      contactEmail: 'creator@example.com',
      consent: true,
      sampleText: '这是一段足够长的代表内容，用来帮助系统理解我的工作方式。',
    });
  });

  it('损坏、过期或不完整的缓存不会被当作可上传资料', () => {
    const storage = new MemoryStorage();
    storage.setItem(CREATION_INTAKE_STORAGE_KEY, '{bad json');
    expect(readLandingDraft(storage)).toBeNull();

    storage.setItem(
      CREATION_INTAKE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        mode: 'kol_profile',
        profileUrl: 'https://example.com/creator',
        consent: true,
        preparedAt: new Date().toISOString(),
      }),
    );
    expect(readLandingDraft(storage)).toBeNull();
  });

  it('存储被浏览器禁用时返回诚实失败，且不会抛错', () => {
    const unavailable = {
      getItem(): string | null {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem(): void {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem(): void {
        throw new DOMException('blocked', 'SecurityError');
      },
    };

    expect(
      saveLandingDraft({ profileUrl: 'https://example.com/creator', consent: true }, unavailable),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(readLandingDraft(unavailable)).toBeNull();
    expect(clearLandingDraft(unavailable)).toBe(false);
  });
});
