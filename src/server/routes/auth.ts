import express from 'express';
import crypto from 'node:crypto';
import type { AppDatabase } from '../db.js';
import type { User } from '../../shared/types.js';
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  verifySessionToken,
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

export function attachUserMiddleware(
  db: AppDatabase,
  sessionSecret: string = process.env.SESSION_SECRET || 'dev-wishlist-secret'
): express.RequestHandler {
  return (req, _res, next) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const userId = verifySessionToken(token, sessionSecret);
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
  const secret = options?.sessionSecret || process.env.SESSION_SECRET || 'dev-wishlist-secret';
  const exchangeFn = options?.oauthExchangeFn || defaultOAuthExchange;
  const env = options?.env || process.env;

  function ensureUserHasDefaultWishlist(user: User): void {
    const existing = db.getUserWishlists(user.id);
    if (existing.length === 0) {
      db.createWishlist(user.id, {
        title: `${user.display_name}'s Wishlist`,
        description: 'Holiday & birthday gift ideas',
      });
    }
  }

  function setSessionCookie(res: express.Response, userId: number): void {
    const token = signSessionToken(userId, secret);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
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
      email?: string;
      password?: string;
      display_name?: string;
    };
    if (!email?.trim() || !password || password.length < 4 || !display_name?.trim()) {
      res.status(400).json({ error: 'Name, email, and a password (4+ chars) are required.' });
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
    setSessionCookie(res, user.id);
    res.status(201).json({ user });
  });

  router.post('/login', (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email?.trim() || !password) {
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
    setSessionCookie(res, user.id);
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

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
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

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const cookieState = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;

    if (!code || !state || !cookieState || state !== cookieState) {
      res.status(400).json({ error: 'Invalid OAuth state or missing authorization code.' });
      return;
    }

    try {
      const redirectUri = getCallbackUrl(provider, env);
      const profile = await exchangeFn(provider, code, redirectUri, env);
      const user = db.upsertOAuthUser(profile);
      ensureUserHasDefaultWishlist(user);
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
      setSessionCookie(res, user.id);
      res.redirect(302, '/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth login failed';
      res.status(502).json({ error: message });
    }
  });

  return router;
}
