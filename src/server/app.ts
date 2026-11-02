import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase, type AppDatabase } from './db.js';
import { resolveSessionSecret } from './auth.js';
import { attachUserMiddleware, createAuthRouter } from './routes/auth.js';
import {
  ALLOWED_RASTER_IMAGE_MIMES,
  downloadImageBlob,
  fetchProductMetadata,
  sanitizeHttpUrl,
  UnsafeUrlError,
} from './fetcher.js';
import { importTtgmList } from './ttgm-importer.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createRateLimiter(maxRequests: number, windowMs: number): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 1000) {
      for (const [k, v] of hits.entries()) {
        if (now > v.resetAt) hits.delete(k);
      }
      if (hits.size > 5000) {
        hits.clear();
      }
    }
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
      return;
    }
    entry.count++;
    next();
  };
}

function sanitizeImageUrlInput(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new UnsafeUrlError('Invalid image URL.');
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\/api\/items\/\d+\/image(\?.*)?$/.test(trimmed)) {
    return trimmed;
  }
  return sanitizeHttpUrl(trimmed);
}

function sanitizeOptionalText(
  raw: unknown,
  maxLen: number,
  fieldName: string
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new UnsafeUrlError(`${fieldName} must be a string.`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) {
    throw new UnsafeUrlError(`${fieldName} exceeds maximum length (${maxLen} chars).`);
  }
  return trimmed;
}

export function createApp(options?: {
  db?: AppDatabase;
  sessionSecret?: string;
  fetchMetadataFn?: typeof fetchProductMetadata;
  importTtgmFn?: typeof importTtgmList;
}): express.Express {
  const db = options?.db || createDatabase();
  const sessionSecret = resolveSessionSecret(options?.sessionSecret);
  const fetchMetadata = options?.fetchMetadataFn || fetchProductMetadata;
  const importTtgm = options?.importTtgmFn || importTtgmList;

  const app = express();
  app.disable('x-powered-by');
  if (
    process.env.TRUST_PROXY === 'true' ||
    (process.env.APP_URL || '').toLowerCase().startsWith('https://')
  ) {
    app.set('trust proxy', 1);
  }

  // Baseline HTTP security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
  });

  // CSRF protection for state-changing API endpoints
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }

    const secFetchSite = req.get('sec-fetch-site')?.toLowerCase();
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      res.status(403).json({ error: 'Cross-site requests are forbidden.' });
      return;
    }

    const origin = req.get('origin');
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        res.status(403).json({ error: 'Invalid request Origin header.' });
        return;
      }
      const reqHost = (req.get('host') || '').toLowerCase();
      let configuredHost = '';
      if (process.env.APP_URL) {
        try {
          configuredHost = new URL(process.env.APP_URL).host.toLowerCase();
        } catch {
          configuredHost = '';
        }
      }
      if (originHost !== reqHost && (!configuredHost || originHost !== configuredHost)) {
        res.status(403).json({ error: 'Cross-origin state-changing requests are forbidden.' });
        return;
      }
    }

    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(attachUserMiddleware(db, sessionSecret));

  const authRateLimiter = createRateLimiter(30, 15 * 60 * 1000);
  const fetchRateLimiter = createRateLimiter(60, 5 * 60 * 1000);
  const reserveRateLimiter = createRateLimiter(40, 5 * 60 * 1000);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth/login', authRateLimiter);
  app.use('/api/auth/register', authRateLimiter);
  app.use('/api/auth', createAuthRouter(db, { sessionSecret }));

  // Public family directory of wishlists
  app.get('/api/family', (_req, res) => {
    const wishlists = db.getPublicWishlists();
    res.json({ wishlists });
  });

  // Current user's wishlists
  app.get('/api/wishlists', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const wishlists = db.getUserWishlists(req.user.id);
    res.json({ wishlists });
  });

  app.post('/api/wishlists', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const { title, description, is_public } = req.body as {
      title?: unknown;
      description?: unknown;
      is_public?: unknown;
    };
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
      res.status(400).json({ error: 'Wishlist title (1-200 chars) is required.' });
      return;
    }
    const descStr = typeof description === 'string' ? description.slice(0, 500) : '';
    const wishlist = db.createWishlist(req.user.id, {
      title: title.trim(),
      description: descStr,
      is_public: typeof is_public === 'boolean' ? is_public : true,
    });
    res.status(201).json({ wishlist });
  });

  // Public wishlist view (spoiler-free if req.user owns the list)
  app.get('/api/wishlists/:slug', (req, res) => {
    const view = db.getWishlistView(req.params.slug, req.user?.id ?? null);
    if (!view) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    res.json(view);
  });

  app.patch('/api/wishlists/:slug', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = db.getWishlistBySlug(req.params.slug);
    if (!existing) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Only the wishlist owner can update this list.' });
      return;
    }
    const body = req.body as { title?: unknown; description?: unknown; is_public?: unknown };
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200)) {
      res.status(400).json({ error: 'Invalid wishlist title.' });
      return;
    }
    const updated = db.updateWishlist(existing.id, req.user.id, {
      title: typeof body.title === 'string' ? body.title.trim() : undefined,
      description: typeof body.description === 'string' ? body.description.slice(0, 500) : undefined,
      is_public: typeof body.is_public === 'boolean' ? body.is_public : undefined,
    });
    res.json({ wishlist: updated });
  });

  app.delete('/api/wishlists/:slug', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = db.getWishlistBySlug(req.params.slug);
    if (!existing) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Only the wishlist owner can delete this list.' });
      return;
    }
    db.deleteWishlist(existing.id, req.user.id);
    res.json({ ok: true });
  });

  // Add item to wishlist
  app.post('/api/wishlists/:slug/items', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = db.getWishlistBySlug(req.params.slug);
    if (!existing) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Only the wishlist owner can add items.' });
      return;
    }
    const { name, section, url, price, image_url, color, size, model, priority } = req.body as {
      name?: unknown;
      section?: unknown;
      url?: unknown;
      price?: unknown;
      image_url?: unknown;
      color?: unknown;
      size?: unknown;
      model?: unknown;
      priority?: unknown;
    };
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 300) {
      res.status(400).json({ error: 'Item name (1-300 chars) is required.' });
      return;
    }

    let safeUrl: string | null = null;
    let safeImageUrl: string | null = null;
    let safeSection: string | null = null;
    let safePrice: string | null = null;
    let safeColor: string | null = null;
    let safeSize: string | null = null;
    let safeModel: string | null = null;

    try {
      safeUrl = sanitizeHttpUrl(url);
      safeImageUrl = sanitizeImageUrlInput(image_url) ?? null;
      safeSection = sanitizeOptionalText(section, 100, 'Section') ?? null;
      safePrice = sanitizeOptionalText(price, 50, 'Price') ?? null;
      safeColor = sanitizeOptionalText(color, 100, 'Color') ?? null;
      safeSize = sanitizeOptionalText(size, 100, 'Size') ?? null;
      safeModel = sanitizeOptionalText(model, 500, 'Notes') ?? null;
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid item field.' });
      return;
    }

    let item = db.addItem(existing.id, {
      name: name.trim(),
      section: safeSection,
      url: safeUrl,
      price: safePrice,
      image_url: safeImageUrl,
      color: safeColor,
      size: safeSize,
      model: safeModel,
      priority: typeof priority === 'number' && Number.isFinite(priority) ? priority : 0,
    });
    if (item.image_url && /^https?:\/\//i.test(item.image_url)) {
      const downloaded = await downloadImageBlob(item.image_url).catch(() => null);
      if (downloaded) {
        item = db.setItemImageBlob(item.id, downloaded.blob, downloaded.mimeType) || item;
      }
    }
    res.status(201).json({ item });
  });

  app.patch('/api/wishlists/:slug/items/:itemId', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = db.getWishlistBySlug(req.params.slug);
    if (!existing) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Only the wishlist owner can edit items.' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    let patchName: string | undefined;
    let patchSection: string | null | undefined;
    let patchUrl: string | null | undefined;
    let patchPrice: string | null | undefined;
    let patchImageUrl: string | null | undefined;
    let patchColor: string | null | undefined;
    let patchSize: string | null | undefined;
    let patchModel: string | null | undefined;

    try {
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 300) {
          throw new UnsafeUrlError('Item name must be 1-300 characters.');
        }
        patchName = body.name.trim();
      }
      patchSection = sanitizeOptionalText(body.section, 100, 'Section');
      patchUrl = body.url === undefined ? undefined : sanitizeHttpUrl(body.url);
      patchPrice = sanitizeOptionalText(body.price, 50, 'Price');
      patchImageUrl = sanitizeImageUrlInput(body.image_url);
      patchColor = sanitizeOptionalText(body.color, 100, 'Color');
      patchSize = sanitizeOptionalText(body.size, 100, 'Size');
      patchModel = sanitizeOptionalText(body.model, 500, 'Notes');
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid item field.' });
      return;
    }

    let updated = db.updateItem(Number(req.params.itemId), existing.id, {
      name: patchName,
      section: patchSection,
      url: patchUrl,
      price: patchPrice,
      image_url: patchImageUrl,
      color: patchColor,
      size: patchSize,
      model: patchModel,
      priority: typeof body.priority === 'number' && Number.isFinite(body.priority) ? body.priority : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    if (updated.image_url && /^https?:\/\//i.test(updated.image_url)) {
      const downloaded = await downloadImageBlob(updated.image_url).catch(() => null);
      if (downloaded) {
        updated = db.setItemImageBlob(updated.id, downloaded.blob, downloaded.mimeType) || updated;
      }
    }
    // Always strip reservation state when returning to owner
    res.json({
      item: {
        ...updated,
        is_reserved: false,
        reserved_by_name: null,
        reserved_at: null,
      },
    });
  });

  // Serve cached item image BLOB from SQLite with strict sandbox CSP & raster allowlist
  app.get('/api/items/:itemId/image', (req, res) => {
    const itemId = Number(req.params.itemId);
    const cached = db.getItemImageBlob(itemId);
    if (!cached || !ALLOWED_RASTER_IMAGE_MIMES.has(cached.mimeType.toLowerCase())) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', cached.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(cached.blob));
  });

  app.delete('/api/wishlists/:slug/items/:itemId', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = db.getWishlistBySlug(req.params.slug);
    if (!existing) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Only the wishlist owner can delete items.' });
      return;
    }
    const ok = db.deleteItem(Number(req.params.itemId), existing.id);
    if (!ok) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    res.json({ ok: true });
  });

  // Guest / Visitor reservation endpoints (no login required!)
  app.post('/api/items/:itemId/reserve', reserveRateLimiter, (req, res) => {
    const itemId = Number(req.params.itemId);
    const rawBodyName = (req.body as { reserved_by_name?: unknown })?.reserved_by_name;
    if (rawBodyName !== undefined && typeof rawBodyName !== 'string') {
      res.status(400).json({ error: 'Invalid reservation name.' });
      return;
    }
    const reservedByName = (typeof rawBodyName === 'string' ? rawBodyName.trim() : '') || req.user?.display_name || '';
    if (reservedByName.length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or fewer.' });
      return;
    }

    const result = db.reserveItem(itemId, reservedByName, req.user?.id ?? null);
    if (result.status === 'invalid_name') {
      res.status(400).json({ error: 'Please enter your name to reserve this item.' });
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    if (result.status === 'owner_forbidden') {
      res.status(403).json({ error: 'You cannot reserve items on your own wishlist.' });
      return;
    }
    if (result.status === 'already_reserved') {
      res.status(409).json({ error: 'This item has already been reserved by someone else.' });
      return;
    }
    res.json({ item: result.item });
  });

  app.post('/api/items/:itemId/unreserve', reserveRateLimiter, (req, res) => {
    const itemId = Number(req.params.itemId);
    const result = db.unreserveItem(itemId, req.user?.id ?? null);
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    if (result.status === 'owner_forbidden') {
      res.status(403).json({ error: 'You cannot modify reservations on your own wishlist.' });
      return;
    }
    res.json({ item: result.item });
  });

  // URL Metadata Fetcher
  app.post('/api/fetch-url', fetchRateLimiter, async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const { url } = req.body as { url?: unknown };
    if (typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ error: 'Product URL is required.' });
      return;
    }
    const targetUrl = url.trim();
    console.log(`[API] POST /api/fetch-url: "${targetUrl}"`);
    try {
      const metadata = await fetchMetadata(targetUrl);
      res.json(metadata);
    } catch (err) {
      console.error(`[API] Failed to fetch metadata for "${targetUrl}":`, err instanceof Error ? err.message : err);
      if (err instanceof UnsafeUrlError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch URL' });
    }
  });

  // Import existing list from Things To Get Me
  app.post('/api/wishlists/:slug/import-ttgm', fetchRateLimiter, async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const existing = db.getWishlistBySlug(req.params.slug);
    if (!existing) {
      res.status(404).json({ error: 'Wishlist not found.' });
      return;
    }
    if (existing.user_id !== req.user.id) {
      res.status(403).json({ error: 'Only the wishlist owner can import items.' });
      return;
    }
    const { urlOrCode } = req.body as { urlOrCode?: unknown };
    if (typeof urlOrCode !== 'string' || !urlOrCode.trim()) {
      res.status(400).json({ error: 'Please provide a Things To Get Me link or list code.' });
      return;
    }
    try {
      const summary = await importTtgm(db, existing.id, urlOrCode.trim());
      res.json(summary);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to import Things To Get Me list.',
      });
    }
  });

  // Built-in Privacy Policy, Terms, and Data Deletion endpoints for OAuth Provider validation (Facebook / Google / Amazon)
  app.get('/privacy', (_req, res) => {
    res
      .status(200)
      .type('html')
      .send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy — Family Wishlist</title>
  <meta property="og:title" content="Privacy Policy — Family Wishlist" />
  <meta property="og:description" content="Privacy Policy and Data Handling for our self-hosted Family Wishlist application." />
  <meta property="og:type" content="website" />
  <style>
    body { background: #020617; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 720px; margin: 0 auto; padding: 2.5rem 1.25rem; }
    h1, h2 { color: #f8fafc; }
    p, li { color: #cbd5e1; }
    a { color: #60a5fa; }
    .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 1.75rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Privacy Policy</h1>
    <p><strong>Effective Date:</strong> November 1, 2026</p>
    <p>Family Wishlist is a private, self-hosted family gift-registry application. We respect your privacy and collect only the minimum information required to let you create and share wishlists with family members.</p>
    <h2>1. Information We Collect</h2>
    <ul>
      <li><strong>Authentication Information:</strong> When you sign in using Facebook, Google, Amazon, or local email login, we store your display name, account identifier, and (if provided) email address solely to identify your wishlist account.</li>
      <li><strong>Wishlist &amp; Gift Data:</strong> We store the wishlist titles, items, product links, and gift reservation names that you or your family members enter.</li>
    </ul>
    <h2>2. How We Use Information</h2>
    <p>Your information is used strictly to authenticate your session and display your wishlists to family members with whom you share your link. We never sell, rent, or share your data with third parties or advertisers.</p>
    <h2>3. Data Deletion (<a href="/data-deletion">/data-deletion</a>)</h2>
    <p>You may delete any wishlist or item at any time directly within the application after signing in, or request complete account deletion from the family server administrator.</p>
    <p><a href="/">&larr; Back to Family Wishlist</a></p>
  </div>
</body>
</html>`);
  });

  app.get(['/data-deletion', '/terms'], (_req, res) => {
    res
      .status(200)
      .type('html')
      .send(`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>User Data Deletion &amp; Terms — Family Wishlist</title>
  <meta property="og:title" content="User Data Deletion &amp; Terms — Family Wishlist" />
  <meta property="og:description" content="Instructions for deleting user data from Family Wishlist." />
  <meta property="og:type" content="website" />
  <style>
    body { background: #020617; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 720px; margin: 0 auto; padding: 2.5rem 1.25rem; }
    h1, h2 { color: #f8fafc; }
    p, li { color: #cbd5e1; }
    a { color: #60a5fa; }
    .card { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 1.75rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>User Data Deletion Instructions &amp; Terms of Service</h1>
    <p>Family Wishlist is a private, self-hosted application operated for family and friends.</p>
    <h2>How to Delete Your Data</h2>
    <ol>
      <li>Sign in to your account at <a href="/">Family Wishlist</a>.</li>
      <li>Delete any individual wishlist items or entire wishlists using the <strong>Remove</strong> or <strong>Delete</strong> buttons.</li>
      <li>To remove your OAuth login association and account record completely, revoke the app under your Facebook / Google / Amazon account&apos;s <em>Apps and Websites</em> settings and notify the family server administrator to purge your user record.</li>
    </ol>
    <p><a href="/privacy">View Privacy Policy</a> &middot; <a href="/">&larr; Back to Family Wishlist</a></p>
  </div>
</body>
</html>`);
  });

  // Static client assets & SPA fallback with OpenGraph tags for /w/:slug
  const clientDistDir = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir, { index: false }));
  }

  function renderSpaHtml(meta?: { title: string; description: string }): string {
    const title = escapeHtml(meta?.title || 'Family Wishlist');
    const description = escapeHtml(
      meta?.description || 'Share holiday & birthday wishlists and reserve gifts spoiler-free.'
    );
    const indexPath = path.join(clientDistDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      const rawHtml = fs.readFileSync(indexPath, 'utf8');
      return rawHtml.replace(
        '</head>',
        `  <meta property="og:title" content="${title}" />\n  <meta property="og:description" content="${description}" />\n  <meta property="og:type" content="website" />\n</head>`
      );
    }
    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="shortcut icon" href="/favicon.ico" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:type" content="website" />
</head>
<body class="bg-slate-950 text-slate-50">
  <div id="root"></div>
</body>
</html>`;
  }

  app.get('/w/:slug', (req, res) => {
    const wishlist = db.getWishlistBySlug(req.params.slug);
    if (wishlist) {
      res
        .status(200)
        .type('html')
        .send(
          renderSpaHtml({
            title: wishlist.title,
            description: `View ${wishlist.owner_name}'s wishlist and reserve gifts spoiler-free (no login needed).`,
          })
        );
      return;
    }
    res.status(200).type('html').send(renderSpaHtml());
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.status(200).type('html').send(renderSpaHtml());
  });

  return app;
}
