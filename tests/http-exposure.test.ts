import { describe, expect, it, vi } from 'vitest';
import { corsOrigin } from '../src/http/cors.js';
import { isLocalRequest, authenticate, DEMO_USER } from '../src/http/auth.js';

/**
 * A request as the auth layer sees it. Only the two things the locality decision
 * reads are modelled: headers, and the raw socket address.
 */
function request(options: { headers?: Record<string, string>; remoteAddress?: string | undefined } = {}) {
  return {
    headers: options.headers ?? {},
    socket: { remoteAddress: 'remoteAddress' in options ? options.remoteAddress : '127.0.0.1' }
  } as never;
}

describe('CORS origin', () => {
  // Regression: CORS_ORIGIN was declared in config/env.ts and then never read —
  // server.ts hard-coded `origin: true`, which reflects any caller's Origin.
  it('allows no cross-origin access by default', () => {
    expect(corsOrigin('')).toBe(false);
    expect(corsOrigin('   ')).toBe(false);
  });

  it('passes a literal * rather than reflecting the caller when wildcarded', () => {
    // `true` would reflect the request Origin, which also permits credentialed
    // cross-origin requests; browsers refuse to send credentials to a literal *.
    expect(corsOrigin('*')).toBe('*');
  });

  it('accepts an explicit origin list', () => {
    expect(corsOrigin('https://a.example')).toEqual(['https://a.example']);
    expect(corsOrigin('https://a.example, https://b.example')).toEqual(['https://a.example', 'https://b.example']);
    expect(corsOrigin('https://a.example,,  ,https://b.example')).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('request locality', () => {
  it('accepts a plain loopback request', () => {
    for (const address of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
      expect(isLocalRequest(request({ remoteAddress: address })), address).toBe(true);
    }
  });

  /**
   * Docker NATs the host's connection to the bridge gateway, so the operator's
   * own dashboard request genuinely arrives from 172.x — verified live against
   * the running container, which reported remoteAddress 172.19.0.1. Requiring a
   * literal loopback address here made the bundled dashboard return 401 in the
   * only deployment DAMC actually ships.
   */
  it('accepts the private ranges a containerised deployment arrives from', () => {
    for (const address of ['172.19.0.1', '172.17.0.1', '172.31.255.254', '10.0.0.5', '192.168.1.20', '169.254.1.1', 'fd00::1', 'fe80::1%eth0']) {
      expect(isLocalRequest(request({ remoteAddress: address })), address).toBe(true);
    }
  });

  it('rejects a routable public address', () => {
    for (const address of ['203.0.113.7', '8.8.8.8', '2001:db8::1', '172.32.0.1', '172.15.0.1', '9.9.9.9']) {
      expect(isLocalRequest(request({ remoteAddress: address })), address).toBe(false);
    }
  });

  it('rejects a malformed address rather than assuming local', () => {
    for (const address of ['', 'not-an-ip', '127.0.0', '1.2.3.4.5', '999.999.999.999.1']) {
      expect(isLocalRequest(request({ remoteAddress: address })), JSON.stringify(address)).toBe(false);
    }
    expect(isLocalRequest(request({ remoteAddress: undefined }))).toBe(false);
  });

  /**
   * The case that makes the header check load-bearing rather than belt-and-braces.
   *
   * DAMC spawns cloudflared as its own child process inside the container, so
   * tunnelled traffic from the internet reaches the server from 127.0.0.1 — more
   * "local" than the operator's own dashboard. Address alone cannot tell them
   * apart; the forwarding headers every tunnel and proxy adds can.
   */
  it('rejects a forwarded request even though its socket looks local', () => {
    for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray']) {
      expect(isLocalRequest(request({ remoteAddress: '127.0.0.1', headers: { [header]: 'anything' } })), header).toBe(false);
      expect(isLocalRequest(request({ remoteAddress: '172.19.0.1', headers: { [header]: 'anything' } })), header).toBe(false);
    }
  });
});

describe('dev-mode authentication scope', () => {
  it('resolves a loopback request to the dev user', async () => {
    await expect(authenticate(request({ remoteAddress: '127.0.0.1' }))).resolves.toBe(DEMO_USER);
  });

  it('honours X-DAMC-User-Id only from loopback', async () => {
    const other = '00000000-0000-0000-0000-0000000000ff';
    await expect(authenticate(request({ remoteAddress: '127.0.0.1', headers: { 'x-damc-user-id': other } }))).resolves.toBe(other);
    // Same header, arriving through a proxy or tunnel: impersonation must fail.
    await expect(authenticate(request({ remoteAddress: '127.0.0.1', headers: { 'x-damc-user-id': other, 'x-forwarded-for': '203.0.113.7' } })))
      .rejects.toThrow(/only applies to requests from this machine/);
  });

  it('refuses an unauthenticated request that did not originate on this machine', async () => {
    await expect(authenticate(request({ remoteAddress: '203.0.113.7' }))).rejects.toThrow(/only applies to requests from this machine/);
    // The tunnel case: loopback socket, but forwarded.
    await expect(authenticate(request({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } })))
      .rejects.toThrow(/only applies to requests from this machine/);
  });

  it('serves the containerised dashboard, which arrives from the Docker bridge', async () => {
    await expect(authenticate(request({ remoteAddress: '172.19.0.1' }))).resolves.toBe(DEMO_USER);
  });

  it('refuses every unauthenticated request when dev mode is off', async () => {
    vi.resetModules();
    const previous = process.env.DAMC_DEV_MODE;
    process.env.DAMC_DEV_MODE = 'false';
    try {
      const { authenticate: strict } = await import('../src/http/auth.js');
      await expect(strict(request({ remoteAddress: '127.0.0.1' }))).rejects.toThrow(/Authentication required/);
    } finally {
      if (previous === undefined) delete process.env.DAMC_DEV_MODE;
      else process.env.DAMC_DEV_MODE = previous;
      vi.resetModules();
    }
  });
});
