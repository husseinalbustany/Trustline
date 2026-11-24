import type { Request } from 'express';

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      // A value that is not valid percent-encoding is treated as no cookie.
      return undefined;
    }
  }
  return undefined;
}

export const sessionCookieOptions = {
  httpOnly: true,
  // Never sent on requests that start from another site.
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};
