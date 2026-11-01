import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type OAuthProvider = 'google' | 'facebook' | 'amazon';

export interface OAuthUserProfile {
  provider: OAuthProvider;
  provider_account_id: string;
  email: string;
  display_name: string;
  avatar_url?: string | null;
}

export type OAuthExchangeFn = (
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  env?: NodeJS.ProcessEnv
) => Promise<OAuthUserProfile>;

const INSECURE_PLACEHOLDER_SECRETS = new Set([
  '',
  'dev-wishlist-secret',
  'change-me-in-production',
  'change-me-on-unraid',
]);

let runtimeFallbackSecret: string | null = null;

export function resolveSessionSecret(
  explicitSecret?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const candidate = (explicitSecret ?? env.SESSION_SECRET ?? '').trim();
  if (candidate && !INSECURE_PLACEHOLDER_SECRETS.has(candidate)) {
    return candidate;
  }

  const dataDir = env.DATA_DIR;
  if (dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const secretFile = path.join(dataDir, '.session_secret');
      if (fs.existsSync(secretFile)) {
        const stored = fs.readFileSync(secretFile, 'utf8').trim();
        if (stored.length >= 32) {
          return stored;
        }
      }
      const generated = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
      return generated;
    } catch {
      // Fall back to in-memory random secret if filesystem is read-only
    }
  }

  if (!runtimeFallbackSecret) {
    runtimeFallbackSecret = crypto.randomBytes(32).toString('hex');
  }
  return runtimeFallbackSecret;
}

export function hashPassword(password: string): string {
  const bounded = password.slice(0, 256);
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(bounded, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const bounded = password.slice(0, 256);
  const derived = crypto.scryptSync(bounded, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function signSessionToken(
  userId: number,
  secret: string,
  issuedAtMs: number = Date.now()
): string {
  const payload = `${userId}.${issuedAtMs}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

const DEFAULT_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 60; // 60 days

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS
): number | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userIdStr, timestampStr, sig] = parts;
  const payload = `${userIdStr}.${timestampStr}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const issuedAt = Number(timestampStr);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    return null;
  }
  if (now - issuedAt > maxAgeMs || issuedAt > now + 60_000) {
    return null;
  }

  const userId = Number(userIdStr);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

export function getConfiguredOAuthProviders(env: NodeJS.ProcessEnv = process.env): {
  google: boolean;
  facebook: boolean;
  amazon: boolean;
} {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    facebook: Boolean(env.FACEBOOK_CLIENT_ID && env.FACEBOOK_CLIENT_SECRET),
    amazon: Boolean(env.AMAZON_CLIENT_ID && env.AMAZON_CLIENT_SECRET),
  };
}

export function getCallbackUrl(provider: OAuthProvider, env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${baseUrl}/api/auth/oauth/${provider}/callback`;
}

export function buildOAuthAuthorizeUrl(
  provider: OAuthProvider,
  state: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const redirectUri = getCallbackUrl(provider, env);

  if (provider === 'google') {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID || '');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    return url.toString();
  }

  if (provider === 'facebook') {
    const url = new URL('https://www.facebook.com/v19.0/dialog/oauth');
    url.searchParams.set('client_id', env.FACEBOOK_CLIENT_ID || '');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'email,public_profile');
    url.searchParams.set('state', state);
    return url.toString();
  }

  // Amazon ("Login with Amazon")
  const url = new URL('https://www.amazon.com/ap/oa');
  url.searchParams.set('client_id', env.AMAZON_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'profile');
  url.searchParams.set('state', state);
  return url.toString();
}

export const defaultOAuthExchange: OAuthExchangeFn = async (
  provider,
  code,
  redirectUri,
  env = process.env
) => {
  if (provider === 'google') {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID || '',
        client_secret: env.GOOGLE_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('Google token exchange failed');
    const tokenData = (await tokenRes.json()) as { access_token: string };
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileRes.ok) throw new Error('Google profile fetch failed');
    const profile = (await profileRes.json()) as {
      sub: string;
      email: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (profile.email_verified !== true) {
      throw new Error('Google account email is not verified');
    }
    return {
      provider: 'google',
      provider_account_id: profile.sub,
      email: profile.email,
      display_name: profile.name || profile.email.split('@')[0],
      avatar_url: profile.picture ?? null,
    };
  }

  if (provider === 'facebook') {
    const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
    tokenUrl.searchParams.set('client_id', env.FACEBOOK_CLIENT_ID || '');
    tokenUrl.searchParams.set('client_secret', env.FACEBOOK_CLIENT_SECRET || '');
    tokenUrl.searchParams.set('redirect_uri', redirectUri);
    tokenUrl.searchParams.set('code', code);

    const tokenRes = await fetch(tokenUrl.toString());
    if (!tokenRes.ok) throw new Error('Facebook token exchange failed');
    const tokenData = (await tokenRes.json()) as { access_token: string };

    const profileUrl = new URL('https://graph.facebook.com/me');
    profileUrl.searchParams.set('fields', 'id,name,email,picture');
    profileUrl.searchParams.set('access_token', tokenData.access_token);
    const profileRes = await fetch(profileUrl.toString());
    if (!profileRes.ok) throw new Error('Facebook profile fetch failed');
    const profile = (await profileRes.json()) as {
      id: string;
      name?: string;
      email?: string;
      picture?: { data?: { url?: string } };
    };
    const email = profile.email || `fb-${profile.id}@facebook.local`;
    return {
      provider: 'facebook',
      provider_account_id: profile.id,
      email,
      display_name: profile.name || 'Facebook User',
      avatar_url: profile.picture?.data?.url ?? null,
    };
  }

  // Amazon
  const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.AMAZON_CLIENT_ID || '',
      client_secret: env.AMAZON_CLIENT_SECRET || '',
    }),
  });
  if (!tokenRes.ok) throw new Error('Amazon token exchange failed');
  const tokenData = (await tokenRes.json()) as { access_token: string };
  const profileRes = await fetch('https://api.amazon.com/user/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!profileRes.ok) throw new Error('Amazon profile fetch failed');
  const profile = (await profileRes.json()) as {
    user_id: string;
    name?: string;
    email?: string;
  };
  const email = profile.email || `amz-${profile.user_id}@amazon.local`;
  return {
    provider: 'amazon',
    provider_account_id: profile.user_id,
    email,
    display_name: profile.name || 'Amazon User',
    avatar_url: null,
  };
};
