import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createDatabase, AppDatabase } from '../src/server/db';
import { getConfiguredOAuthProviders } from '../src/server/auth';
import { createAuthRouter, attachUserMiddleware } from '../src/server/routes/auth';

describe('Authentication & OAuth', () => {
  let db: AppDatabase;
  let app: express.Express;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(attachUserMiddleware(db, 'test-secret'));
    app.use(
      '/api/auth',
      createAuthRouter(db, {
        sessionSecret: 'test-secret',
        env: {
          AMAZON_CLIENT_ID: 'amz-id',
          AMAZON_CLIENT_SECRET: 'amz-sec',
        },
        oauthExchangeFn: async (provider, code) => ({
          provider,
          provider_account_id: `${provider}-${code}`,
          email: `${provider}@example.com`,
          display_name: `${provider.toUpperCase()} User`,
        }),
      })
    );
  });

  it('registers a local user, creates a default wishlist, and persists session via cookie', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'blake@example.com', password: 'password123', display_name: 'Blake' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.display_name).toBe('Blake');
    const cookies = reg.headers['set-cookie'];

    const me = await request(app).get('/api/auth/me').set('Cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('blake@example.com');
  });

  it('detects configured Google, Facebook, and Amazon OAuth providers and completes OAuth callback', async () => {
    const providers = getConfiguredOAuthProviders({
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-sec',
      FACEBOOK_CLIENT_ID: 'fb-id',
      FACEBOOK_CLIENT_SECRET: 'fb-sec',
      AMAZON_CLIENT_ID: 'amz-id',
      AMAZON_CLIENT_SECRET: 'amz-sec',
    });
    expect(providers).toEqual({ google: true, facebook: true, amazon: true });

    const start = await request(app).get('/api/auth/oauth/amazon');
    expect(start.status).toBe(302);
    const stateCookie = start.headers['set-cookie'];
    const redirectUrl = new URL(start.headers.location);
    const state = redirectUrl.searchParams.get('state')!;

    const cb = await request(app)
      .get(`/api/auth/oauth/amazon/callback?code=testcode&state=${state}`)
      .set('Cookie', stateCookie);
    expect(cb.status).toBe(302);

    const sessionCookie = cb.headers['set-cookie'];
    const me = await request(app).get('/api/auth/me').set('Cookie', sessionCookie);
    expect(me.body.user.email).toBe('amazon@example.com');
  });

  it('returns 400 when initiating OAuth on an unconfigured provider', async () => {
    const res = await request(app).get('/api/auth/oauth/google');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });
});
