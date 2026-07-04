/**
 * Minimal cookie jar for the Sumo ALB stickiness cookies (AWSALB/AWSALBCORS).
 * Live finding (EU, 2026-07-03): reads succeed even without cookies, so this is cheap
 * insurance, not a correctness requirement. We therefore keep it deliberately simple:
 * one jar per client (single Sumo host), name→value, no attribute handling.
 */
export class CookieJar {
  private cookies = new Map<string, string>();

  storeFrom(headers: Headers): void {
    // getSetCookie exists on Node >= 20 Headers; fall back for minimal Headers mocks.
    const setCookies: string[] =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie') as string]
          : [];
    for (const line of setCookies) {
      const first = line.split(';', 1)[0] ?? '';
      const eq = first.indexOf('=');
      if (eq > 0) {
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (name) this.cookies.set(name, value);
      }
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}
