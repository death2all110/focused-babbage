import express from 'express';
import crypto from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { User } from '../../shared/types.js';
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  verifySessionToken,
  resolveSessionSecret,
  getConfiguredOAuthProviders,
  buildOAuthAuthorizeUrl,
  getCallbackUrl,
  defaultOAuthExchange,
  type OAuthExchangeFn,
  type OAuthProvider,
} from '../auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: User | null;
    }
  }
}

const SESSION_COOKIE = 'wishlist_session';
const OAUTH_STATE_COOKIE = 'wishlist_oauth_state';

function isValidProvider(p: string): p is OAuthProvider {
  return p === 'google' || p === 'facebook' || p === 'amazon';
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function attachUserMiddleware(
  db: AppDatabase,
  sessionSecret?: string
): express.RequestHandler {
  const secret = resolveSessionSecret(sessionSecret);
  return (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const userId = verifySessionToken(token, secret);
    req.user = userId ? db.getUserById(userId) ?? null : null;
    next();
  };
}

export function createAuthRouter(
  db: AppDatabase,
  options?: {
    sessionSecret?: string;
    oauthExchangeFn?: OAuthExchangeFn;
    env?: NodeJS.ProcessEnv;
  }
): express.Router {
  const router = express.Router();
  const env = options?.env || process.env;
  const secret = resolveSessionSecret(options?.sessionSecret, env);
  const exchangeFn = options?.oauthExchangeFn || defaultOAuthExchange;

  function isSecureCookie(req: express.Request): boolean {
    return Boolean(req.secure || (env.APP_URL || '').toLowerCase().startsWith('https://'));
  }

  function ensureUserHasDefaultWishlist(user: User): void {
    const existing = db.getUserWishlists(user.id);
    if (existing.length === 0) {
      db.createWishlist(user.id, {
        title: `${user.display_name}'s Wishlist`,
        description: 'Holiday & birthday gift ideas',
      });
    }
  }

  function setSessionCookie(req: express.Request, res: express.Response, userId: number): void {
    const token = signSessionToken(userId, secret);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureCookie(req),
      path: '/',
      maxAge: 1000 * 60 * 60 * 24 * 60, // 60 days
    });
  }

  router.get('/providers', (_req, res) => {
    res.json({
      providers: getConfiguredOAuthProviders(env),
      local: true,
    });
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ?? null });
  });

  router.post('/register', (req, res) => {
    const { email, password, display_name } = req.body as {
      email?: unknown;
      password?: unknown;
      display_name?: unknown;
    };
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      typeof display_name !== 'string' ||
      !email.trim() ||
      email.trim().length > 254 ||
      password.length < 8 ||
      password.length > 256 ||
      !display_name.trim() ||
      display_name.trim().length > 100
    ) {
      res.status(400).json({ error: 'Name, email, and a password (8+ chars) are required.' });
      return;
    }

    const existing = db.getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const user = db.createUser({
      email,
      display_name,
      password_hash: hashPassword(password),
    });
    ensureUserHasDefaultWishlist(user);
    setSessionCookie(req, res, user.id);
    res.status(201).json({ user });
  });

  router.post('/login', (req, res) => {
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password ||
      password.length > 256
    ) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const userWithHash = db.getUserByEmail(email);
    if (!userWithHash || !userWithHash.password_hash || !verifyPassword(password, userWithHash.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const user: User = {
      id: userWithHash.id,
      email: userWithHash.email,
      display_name: userWithHash.display_name,
      avatar_url: userWithHash.avatar_url,
      created_at: userWithHash.created_at,
    };
    ensureUserHasDefaultWishlist(user);
    setSessionCookie(req, res, user.id);
    res.json({ user });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/oauth/:provider', (req, res) => {
    const { provider } = req.params;
    if (!isValidProvider(provider)) {
      res.status(400).json({ error: 'Unsupported OAuth provider.' });
      return;
    }

    const configured = getConfiguredOAuthProviders(env);
    if (!configured[provider]) {
      res.status(400).json({ error: `${provider} OAuth is not configured on this server.` });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureCookie(req),
      path: '/',
      maxAge: 1000 * 60 * 15,
    });
    const authorizeUrl = buildOAuthAuthorizeUrl(provider, state, env);
    res.redirect(302, authorizeUrl);
  });

  router.get('/oauth/:provider/callback', async (req, res) => {
    const { provider } = req.params;
    if (!isValidProvider(provider)) {
      res.status(400).json({ error: 'Unsupported OAuth provider.' });
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;

    if (!code || !state || !cookieState || !timingSafeStringEqual(state, cookieState)) {
      res.status(400).json({ error: 'Invalid OAuth state or missing authorization code.' });
      return;
    }

    try {
      const redirectUri = getCallbackUrl(provider, env);
      const profile = await exchangeFn(provider, code, redirectUri, env);
      const user = db.upsertOAuthUser(profile);
      ensureUserHasDefaultWishlist(user);
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
      setSessionCookie(req, res, user.id);
      res.redirect(302, '/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth login failed';
      res.status(502).json({ error: message });
    }
  });

  return router;
}
