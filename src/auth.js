import crypto from 'node:crypto';

const digest = (s) => crypto.createHash('sha256').update(s).digest();

/** HTTP Basic Auth：帳號不限，只驗證密碼（常數時間比對）。 */
export function createAuth(password) {
  const expected = digest(password);
  return {
    check(header) {
      if (!header || !header.startsWith('Basic ')) return false;
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) return false;
      return crypto.timingSafeEqual(digest(decoded.slice(i + 1)), expected);
    },
  };
}
