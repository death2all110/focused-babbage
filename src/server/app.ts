import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase, type AppDatabase } from './db.js';
import { attachUserMiddleware, createAuthRouter } from './routes/auth.js';
import { fetchProductMetadata, UnsafeUrlError } from './fetcher.js';
import { importTtgmList } from './ttgm-importer.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createApp(options?: {
  db?: AppDatabase;
  sessionSecret?: string;
  fetchMetadataFn?: typeof fetchProductMetadata;
  importTtgmFn?: typeof importTtgmList;
}): express.Express {
  const db = options?.db || createDatabase();
  const sessionSecret = options?.sessionSecret || process.env.SESSION_SECRET || 'dev-wishlist-secret';
  const fetchMetadata = options?.fetchMetadataFn || fetchProductMetadata;
  const importTtgm = options?.importTtgmFn || importTtgmList;

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(attachUserMiddleware(db, sessionSecret));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

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
      title?: string;
      description?: string;
      is_public?: boolean;
    };
    if (!title?.trim()) {
      res.status(400).json({ error: 'Wishlist title is required.' });
      return;
    }
    const wishlist = db.createWishlist(req.user.id, { title, description, is_public });
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
    const updated = db.updateWishlist(existing.id, req.user.id, req.body);
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
  app.post('/api/wishlists/:slug/items', (req, res) => {
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
    const { name, url, price, image_url, color, size, model, priority } = req.body as {
      name?: string;
      url?: string | null;
      price?: string | null;
      image_url?: string | null;
      color?: string | null;
      size?: string | null;
      model?: string | null;
      priority?: number;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: 'Item name is required.' });
      return;
    }
    const item = db.addItem(existing.id, {
      name,
      url,
      price,
      image_url,
      color,
      size,
      model,
      priority,
    });
    res.status(201).json({ item });
  });

  app.patch('/api/wishlists/:slug/items/:itemId', (req, res) => {
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
    const updated = db.updateItem(Number(req.params.itemId), existing.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Item not found.' });
      return;
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
  app.post('/api/items/:itemId/reserve', (req, res) => {
    const itemId = Number(req.params.itemId);
    const bodyName = (req.body as { reserved_by_name?: string })?.reserved_by_name;
    const reservedByName = bodyName?.trim() || req.user?.display_name || '';

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

  app.post('/api/items/:itemId/unreserve', (req, res) => {
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
  app.post('/api/fetch-url', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const { url } = req.body as { url?: string };
    if (!url?.trim()) {
      res.status(400).json({ error: 'Product URL is required.' });
      return;
    }
    try {
      const metadata = await fetchMetadata(url.trim());
      res.json(metadata);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch URL' });
    }
  });

  // Import existing list from Things To Get Me
  app.post('/api/wishlists/:slug/import-ttgm', async (req, res) => {
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
    const { urlOrCode } = req.body as { urlOrCode?: string };
    if (!urlOrCode?.trim()) {
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
  <title>${title}</title>
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
