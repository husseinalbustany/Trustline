import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt with the parameters OWASP recommends (N=2^17, r=8, p=1).
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, n = N, r = R, p = P) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N: n, r, p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Returns `scrypt$N$r$p$salt$hash`, with salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64url'),
    Number(n),
    Number(r),
    Number(p),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
