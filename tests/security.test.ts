import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDatabase, AppDatabase } from '../src/server/db';
import { createApp } from '../src/server/app';
import {
  resolveSessionSecret,
  signSessionToken,
  verifySessionToken,
} from '../src/server/auth';
import {
  validateSafeExternalUrl,
  assertSafeResolvedHostname,
  downloadImageBlob,
} from '../src/server/fetcher';
import { resolveTtgmUrl } from '../src/server/ttgm-importer';

describe('Security Hardening Suite', () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp({ db, sessionSecret: 'test-strong-secret-key-for-unit-tests' });
  });

  it('CRIT-01: rejects placeholder session secrets and expires old session tokens', () => {
    const generated1 = resolveSessionSecret('change-me-on-unraid', {});
    const generated2 = resolveSessionSecret('dev-wishlist-secret', {});
    expect(generated1).not.toBe('change-me-on-unraid');
    expect(generated2).not.toBe('dev-wishlist-secret');
    expect(generated1.length).toBeGreaterThanOrEqual(64);

    // Valid token verifies
    const validToken = signSessionToken(42, 'secret-123');
    expect(verifySessionToken(validToken, 'secret-123')).toBe(42);

    // Expired token (61 days old) is rejected
    const expiredTs = Date.now() - 61 * 24 * 60 * 60 * 1000;
    const expiredToken = signSessionToken(42, 'secret-123', expiredTs);
    expect(verifySessionToken(expiredToken, 'secret-123')).toBeNull();
  });

  it('CRIT-02: blocks SVG image downloads and serves cached images with sandbox CSP & nosniff', async () => {
    const svgPayload = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    // 1. Explicit image/svg+xml MIME is rejected
    const svgDownload = await downloadImageBlob('https://cdn.example.com/malicious.svg', {
      fetchFn: async () =>
        new Response(svgPayload, {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
    });
    expect(svgDownload).toBeNull();

    // 2. SVG disguised as application/octet-stream is rejected via magic-byte check
    const disguisedSvg = await downloadImageBlob('https://cdn.example.com/disguised.jpg', {
      fetchFn: async () =>
        new Response(svgPayload, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
    });
    expect(disguisedSvg).toBeNull();

    // 3. Valid PNG is served with Content-Security-Policy: default-src 'none'; sandbox and nosniff
    const user = db.createUser({ email: 'sec@example.com', display_name: 'Sec' });
    const list = db.createWishlist(user.id, { title: 'Sec List' });
    const item = db.addItem(list.id, { name: 'Safe Item' });
    const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    db.setItemImageBlob(item.id, validPng, 'image/png');

    const res = await request(app).get(`/api/items/${item.id}/image`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('CRIT-03: blocks CGNAT/Tailscale IPs, DNS rebinding domains (.nip.io), private DNS resolution, and non-dot TTGM domains', async () => {
    expect(() => validateSafeExternalUrl('http://100.64.0.1/internal')).toThrow();
    expect(() => validateSafeExternalUrl('http://198.18.0.1/bench')).toThrow();
    expect(() => validateSafeExternalUrl('http://[::127.0.0.1]/compat')).toThrow();
    expect(() => validateSafeExternalUrl('http://[64:ff9b::192.168.1.1]/nat64')).toThrow();
    expect(() => validateSafeExternalUrl('http://192.168.1.100.nip.io/unraid')).toThrow();
    expect(() => validateSafeExternalUrl('http://127.0.0.1.sslip.io/admin')).toThrow();

    await expect(
      assertSafeResolvedHostname('internal-unraid.example.com', async () => [
        { address: '192.168.1.50', family: 4 },
      ])
    ).rejects.toThrow(/private or reserved/i);

    await expect(
      assertSafeResolvedHostname('public-store.example.com', async () => [
        { address: '93.184.216.34', family: 4 },
      ])
    ).resolves.toBeUndefined();

    // Dot-boundary check on thingstogetme.com
    expect(() => resolveTtgmUrl('https://evilthingstogetme.com/902589a87070')).toThrow();
    expect(resolveTtgmUrl('https://www.thingstogetme.com/902589a87070')).toBe(
      'https://www.thingstogetme.com/902589a87070'
    );
  });

  it('HIGH-01: rejects javascript: and data: URIs in item URLs on create and update', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@example.com', password: 'password123', display_name: 'Owner' });
    const cookie = reg.headers['set-cookie'];
    const lists = await request(app).get('/api/wishlists').set('Cookie', cookie);
    const slug = lists.body.wishlists[0].slug;

    const badCreate = await request(app)
      .post(`/api/wishlists/${slug}/items`)
      .set('Cookie', cookie)
      .send({ name: 'XSS Item', url: 'javascript:alert(document.cookie)' });
    expect(badCreate.status).toBe(400);

    const goodCreate = await request(app)
      .post(`/api/wishlists/${slug}/items`)
      .set('Cookie', cookie)
      .send({ name: 'Safe Item', url: 'https://www.amazon.com/dp/B083K8LRM6' });
    expect(goodCreate.status).toBe(201);

    const badPatch = await request(app)
      .patch(`/api/wishlists/${slug}/items/${goodCreate.body.item.id}`)
      .set('Cookie', cookie)
      .send({ url: 'data:text/html,<script>alert(1)</script>' });
    expect(badPatch.status).toBe(400);
  });

  it('HIGH-03 & MED-01..03: enforces CSRF Origin/Sec-Fetch-Site checks, 8-char passwords, guest name limits, and security headers', async () => {
    // 1. Security headers present on responses
    const health = await request(app).get('/api/health');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");

    // 2. Password minimum length is 8 characters
    const shortPw = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@example.com', password: '1234', display_name: 'Short' });
    expect(shortPw.status).toBe(400);

    // 3. Cross-site POST is blocked by CSRF middleware
    const csrfAttempt = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'https://evil-attacker.example.com');
    expect(csrfAttempt.status).toBe(403);

    const secFetchAttempt = await request(app)
      .post('/api/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(secFetchAttempt.status).toBe(403);

    // 4. Guest reservation rejects overly long (>100 char) names
    const user = db.createUser({ email: 'host@example.com', display_name: 'Host' });
    const list = db.createWishlist(user.id, { title: 'Host List' });
    const item = db.addItem(list.id, { name: 'Gift' });

    const longReserve = await request(app)
      .post(`/api/items/${item.id}/reserve`)
      .send({ reserved_by_name: 'A'.repeat(150) });
    expect(longReserve.status).toBe(400);

    // 5. HIGH-02: Pre-registered local password is cleared if the real owner signs in via OAuth
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'victim@example.com', password: 'attackerpassword123', display_name: 'Attacker' });
    db.upsertOAuthUser({
      provider: 'google',
      provider_account_id: 'google-sub-999',
      email: 'victim@example.com',
      display_name: 'Real Victim',
    });
    const attackerLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'victim@example.com', password: 'attackerpassword123' });
    expect(attackerLogin.status).toBe(401);
  });
});
