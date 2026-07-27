import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/design-claude.css'), 'utf8');

function relativeLuminance(hex: string): number {
  const channels = hex
    .match(/[0-9a-f]{2}/gi)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe('custom login measurable accessibility rules', () => {
  it('keeps muted 12px login text above WCAG AA contrast on the card surface', () => {
    const muted = css.match(/--cb-muted:\s*(#[0-9a-f]{6})/i)?.[1];
    const card = css.match(/--cb-surface-card:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(muted).toBeDefined();
    expect(card).toBeDefined();
    expect(contrastRatio(muted!, card!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the public header Agent entry at least 44px at every breakpoint', () => {
    const rules = [...css.matchAll(/\.cb-public-shell__agent-entry\s*\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThanOrEqual(1);
    for (const [, body] of rules) {
      const height = Number(body?.match(/min-height:\s*(\d+)px/)?.[1]);
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });
});
