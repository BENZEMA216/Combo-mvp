import { createPublicKey, KeyObject, verify } from 'node:crypto';

export type P256PublicKeyInput = string | Buffer | KeyObject;

/**
 * 验证 base64url 编码的 64-byte IEEE-P1363 P-256 签名。
 * DER、错误曲线、私钥格式异常和解析错误都 fail closed。
 */
export function verifyP256P1363Signature(
  bytes: Uint8Array,
  signature: string,
  registeredPublicKey: P256PublicKeyInput,
): boolean {
  try {
    const signatureBytes = Buffer.from(signature, 'base64url');
    if (signatureBytes.byteLength !== 64) return false;
    if (signatureBytes.toString('base64url') !== signature) return false;
    const publicKey =
      registeredPublicKey instanceof KeyObject
        ? registeredPublicKey
        : createPublicKey(registeredPublicKey);
    if (publicKey.type !== 'public') return false;
    if (publicKey.asymmetricKeyType !== 'ec') return false;
    const curve = publicKey.asymmetricKeyDetails?.namedCurve;
    if (curve !== 'prime256v1' && curve !== 'P-256') return false;
    return verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signatureBytes);
  } catch {
    return false;
  }
}
