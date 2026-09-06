export function containsUnsafeAgentText(value: string): boolean {
  if (/\p{Cf}/u.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x08 ||
      (unit >= 0x0b && unit <= 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x2028 ||
      unit === 0x2029
    ) {
      return true;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Reject credential-shaped material before generated text can become a portable artifact.
 * Keep this intentionally narrower than general PII redaction: ordinary prose is allowed, while
 * private-key blocks, authentication headers, known vendor tokens, and explicit secret assignments
 * fail closed.
 */
export function containsCredentialMaterial(value: string): boolean {
  const normalizedSpacing = value.replace(/\p{Zs}/gu, ' ');
  if (
    /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----/u.test(normalizedSpacing) ||
    /-----BEGIN PGP PRIVATE KEY BLOCK-----/u.test(normalizedSpacing) ||
    /\b(?:authorization|proxy-authorization)[ \t]*:[ \t]*(?:Bearer|Basic|Token)[ \t]+[^\s,;]{6,}/iu.test(
      normalizedSpacing,
    ) ||
    /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|pk-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/u.test(
      normalizedSpacing,
    )
  ) {
    return true;
  }
  const schemeCandidates = normalizedSpacing.matchAll(
    /\b(?:Bearer|Basic|Token)[ \t]+([A-Za-z0-9._~+\-/=]{12,})/giu,
  );
  for (const match of schemeCandidates) {
    const candidate = stripTerminalSentencePunctuation(match[1]);
    if (
      candidate.length >= 12 &&
      /[0-9.~+/=]/u.test(candidate) &&
      !isCommonAlgorithmLabel(candidate)
    ) {
      return true;
    }
  }

  const explicitAssignments = normalizedSpacing.matchAll(
    /(["'`]?)((?:api[_ -]?key|secret[_ -]?key|access[_ -]?key|secret|token|password|passwd|pwd|auth[_ -]?token|client[_ -]?secret|private[_ -]?key))\1[ \t\r\n]*=[ \t\r\n]*(["'`]?)([^\s"'`,;)}[\]]{6,})\3/giu,
  );
  if (!explicitAssignments.next().done) return true;

  const labelledAssignments = normalizedSpacing.matchAll(
    /(["'`]?)((?:api[_ -]?key|secret[_ -]?key|access[_ -]?key|secret|token|password|passwd|pwd|auth[_ -]?token|client[_ -]?secret|private[_ -]?key))\1[ \t\r\n]*:[ \t\r\n]*(["'`]?)([^\s"'`,;)}[\]]{6,})\3/giu,
  );
  for (const assignment of labelledAssignments) {
    const candidate = stripTerminalSentencePunctuation(assignment[4]);
    if (
      /[A-Za-z]/u.test(candidate) &&
      /[0-9.~+/=]/u.test(candidate) &&
      !isCommonAlgorithmLabel(candidate)
    ) {
      return true;
    }
  }
  return false;
}

function stripTerminalSentencePunctuation(value: string | undefined): string {
  return value?.replace(/[.!?]+$/u, '') ?? '';
}

function isCommonAlgorithmLabel(value: string): boolean {
  return /^(?:sha-?(?:1|224|256|384|512)|sha3-?(?:224|256|384|512)|md-?5|aes-?(?:128|192|256)(?:-(?:cbc|ctr|gcm))?|rsa-?(?:2048|3072|4096)|hmac-sha-?(?:1|224|256|384|512)|ed25519|argon2(?:id|i|d)?|pbkdf2|scrypt|bcrypt)$/iu.test(
    value,
  );
}
