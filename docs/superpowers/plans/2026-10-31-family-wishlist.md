# Family Wishlist Web Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted, Dockerized family wishlist web application with multi-store URL metadata fetching, *Things To Get Me* list migration, OAuth + local authentication, and spoiler-free no-login guest reservations.

**Architecture:** A single-container Node.js 20+ TypeScript application using Express and `better-sqlite3` (`/data/wishlist.db`) that serves both a REST JSON API and a React + Tailwind CSS dark-theme SPA (with server-side OpenGraph tag injection on `/w/:slug` for Facebook Messenger link previews). Product metadata fetching uses a layered HTML/JSON-LD/store-state parser with SSRF guards and headless-browser/manual fallbacks, plus a dedicated *Things To Get Me* (`window.ttgmList`) importer.

**Tech Stack:** Node.js 20+, TypeScript, Express, `better-sqlite3`, `cheerio`, React 18, Vite, Tailwind CSS, Vitest, Supertest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-31-family-wishlist-design.md`

## Global Constraints

- **Node & Package Manager:** Node.js 20+, `npm`, TypeScript strict mode (`"strict": true`).
- **Single-Volume Persistence:** All persistent state must live under `process.env.DATA_DIR || "./data"` (default `/data` in Docker, SQLite file `wishlist.db`).
- **No-Login Guest Reservations:** Viewing `/w/:slug` and reserving/unreserving items must never require authentication; guests provide `reserved_by_name`.
- **Strict Spoiler-Free Guarantee:** Whenever the authenticated requester owns the wishlist (`viewerUserId === wishlist.user_id`), the backend must strip reservation state (`is_reserved: false`, `reserved_by_name: null`, `reserved_at: null`) and *Things To Get Me* import summaries must never report how many imported items were reserved.
- **Dark Theme & Input Contrast:** All UI surfaces and form inputs must use dark backgrounds (`bg-slate-900` / `#0f172a`) with crisp light text (`text-slate-50` / `#f8fafc`) and subtle borders (`border-slate-700` / `#334155`)—never white textbox backgrounds.

## Review Focus

1. **Concurrent / Duplicate Guest Reservation Race Condition:** When two family members click "Reserve" on the same item nearly simultaneously, the second request must fail with HTTP `409 Conflict` rather than silently overwriting the first person's reservation name (pinned in Task 1 & Task 5).
2. **SSRF via Product URL Fetcher / TTGM Importer:** Submitting `http://127.0.0.1`, `http://localhost`, `http://169.254.169.254`, private LAN IPs (`10.x`, `192.168.x`, `172.16-31.x`), or `file://` URLs to `/api/fetch-url` must be rejected before making a network request (pinned in Task 3).
3. **Price & Relative Image Normalization Across Retailers:** Retailers and *Things To Get Me* exports often supply bare numeric prices (`"47.48"` without `$`) or protocol-relative/path-relative image URLs (`"//..."` or `"/images/..."`); the parser must normalize prices to `"$47.48"` and resolve relative image URLs against the product URL (pinned in Task 3 & Task 4).
4. **Spoiler Leak During *Things To Get Me* Import:** Because the list owner triggers the *Things To Get Me* import for their own list, migrating active reservations (`item_users.length > 0`) must set `is_reserved = 1` in SQLite while returning `is_reserved: false` and a spoiler-free import summary to the owner (pinned in Task 4 & Task 5).
5. **Legacy *Things To Get Me* Note Artifacts:** *Things To Get Me* items previously imported from Amazon contain trailing boilerplate like `Size : Encoder knob, Style : 30V 10A, > medium, >  Needs    1      has    0`; the importer must strip `> medium, > Needs ... has ...` and extract structured `size` / `color` / `model` notes cleanly (pinned in Task 4).

---

### Task 1: Project Scaffolding & SQLite Data Layer

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `src/shared/types.ts`
- Create: `src/server/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces:
  - `src/shared/types.ts`:
    - `User { id: number; email: string; display_name: string; avatar_url: string | null; created_at: string }`
    - `Wishlist { id: number; user_id: number; owner_name: string; slug: string; title: string; description: string; is_public: boolean; created_at: string; updated_at: string }`
    - `WishlistItem { id: number; wishlist_id: number; name: string; url: string | null; price: string | null; image_url: string | null; color: string | null; size: string | null; model: string | null; priority: number; is_reserved: boolean; reserved_by_name: string | null; reserved_at: string | null; created_at: string; updated_at: string }`
    - `WishlistViewResponse { wishlist: Wishlist; is_owner: boolean; items: WishlistItem[] }`
    - `FetchedProductMetadata { url: string; name: string; price: string | null; image_url: string | null; color: string | null; size: string | null; model: string | null; store_name: string | null; partial: boolean }`
    - `TtgmImportSummary { imported_count: number; skipped_received_count: number; enriched_count: number; items: WishlistItem[] }`
  - `src/server/db.ts`:
    - `createDatabase(dbPath?: string): AppDatabase`
    - `AppDatabase` methods:
      - `createUser(input: { email: string; display_name: string; password_hash?: string | null; avatar_url?: string | null }): User`
      - `getUserByEmail(email: string): (User & { password_hash: string | null }) | undefined`
      - `getUserById(id: number): User | undefined`
      - `upsertOAuthUser(input: { provider: 'google' | 'facebook' | 'amazon'; provider_account_id: string; email: string; display_name: string; avatar_url?: string | null }): User`
      - `createWishlist(userId: number, input: { title: string; description?: string; slug?: string; is_public?: boolean }): Wishlist`
      - `getUserWishlists(userId: number): Wishlist[]`
      - `getPublicWishlists(): Wishlist[]`
      - `getWishlistBySlug(slug: string): Wishlist | undefined`
      - `updateWishlist(id: number, userId: number, input: Partial<{ title: string; description: string; is_public: boolean }>): Wishlist | undefined`
      - `deleteWishlist(id: number, userId: number): boolean`
      - `addItem(wishlistId: number, input: { name: string; url?: string | null; price?: string | null; image_url?: string | null; color?: string | null; size?: string | null; model?: string | null; priority?: number; is_reserved?: boolean; reserved_by_name?: string | null }): WishlistItem`
      - `updateItem(itemId: number, wishlistId: number, input: Partial<Omit<WishlistItem, 'id' | 'wishlist_id' | 'is_reserved' | 'reserved_by_name' | 'reserved_at' | 'created_at' | 'updated_at'>>): WishlistItem | undefined`
      - `deleteItem(itemId: number, wishlistId: number): boolean`
      - `getWishlistView(slug: string, viewerUserId: number | null): WishlistViewResponse | undefined`
      - `reserveItem(itemId: number, reservedByName: string, viewerUserId?: number | null): { status: 'ok'; item: WishlistItem } | { status: 'not_found' | 'already_reserved' | 'owner_forbidden' | 'invalid_name' }`
      - `unreserveItem(itemId: number, viewerUserId?: number | null): { status: 'ok'; item: WishlistItem } | { status: 'not_found' | 'owner_forbidden' }`

- [ ] **Step 1: Initialize `package.json`, `tsconfig.json`, `vite.config.ts`, and install dependencies**

Install runtime packages (`express`, `better-sqlite3`, `cheerio`, `cookie-parser`, `react`, `react-dom`, `lucide-react`) and dev packages (`typescript`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`, `autoprefixer`, `vitest`, `supertest`, `@types/express`, `@types/better-sqlite3`, `@types/cookie-parser`, `@types/supertest`, `@types/react`, `@types/react-dom`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `tsx`).

- [ ] **Step 2: Write the failing database & spoiler-protection tests in `tests/db.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase, AppDatabase } from '../src/server/db';

describe('AppDatabase', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('creates a user, default wishlist, and items', () => {
    const user = db.createUser({ email: 'sarah@example.com', display_name: 'Sarah' });
    const list = db.createWishlist(user.id, { title: "Sarah's Holiday List" });
    const item = db.addItem(list.id, {
      name: 'KitchenAid Stand Mixer',
      price: '$349.99',
      color: 'Pistachio',
      size: '5 Quart',
      url: 'https://www.target.com/p/mixer',
    });
    expect(item.name).toBe('KitchenAid Stand Mixer');
    expect(item.is_reserved).toBe(false);
  });

  it('allows guest reservation and hides reservation state from list owner', () => {
    const owner = db.createUser({ email: 'sarah@example.com', display_name: 'Sarah' });
    const list = db.createWishlist(owner.id, { title: "Sarah's List" });
    const item = db.addItem(list.id, { name: 'Wool Sweater', price: '$59.50' });

    const res = db.reserveItem(item.id, 'Aunt Linda', null);
    expect(res.status).toBe('ok');

    // Visitor view sees reservation
    const guestView = db.getWishlistView(list.slug, null)!;
    expect(guestView.is_owner).toBe(false);
    expect(guestView.items[0].is_reserved).toBe(true);
    expect(guestView.items[0].reserved_by_name).toBe('Aunt Linda');

    // Owner view strips reservation completely
    const ownerView = db.getWishlistView(list.slug, owner.id)!;
    expect(ownerView.is_owner).toBe(true);
    expect(ownerView.items[0].is_reserved).toBe(false);
    expect(ownerView.items[0].reserved_by_name).toBeNull();
    expect(ownerView.items[0].reserved_at).toBeNull();
  });

  it('rejects duplicate reservation on an already reserved item and rejects empty guest name', () => {
    const owner = db.createUser({ email: 'sarah@example.com', display_name: 'Sarah' });
    const list = db.createWishlist(owner.id, { title: "Sarah's List" });
    const item = db.addItem(list.id, { name: 'Wool Sweater' });

    expect(db.reserveItem(item.id, '   ', null).status).toBe('invalid_name');
    expect(db.reserveItem(item.id, 'Uncle Bob', null).status).toBe('ok');
    expect(db.reserveItem(item.id, 'Aunt Linda', null).status).toBe('already_reserved');

    // Unreserve restores availability
    expect(db.unreserveItem(item.id, null).status).toBe('ok');
    expect(db.reserveItem(item.id, 'Aunt Linda', null).status).toBe('ok');
  });

  it('prevents wishlist owner from reserving or unreserving items on their own list', () => {
    const owner = db.createUser({ email: 'sarah@example.com', display_name: 'Sarah' });
    const list = db.createWishlist(owner.id, { title: "Sarah's List" });
    const item = db.addItem(list.id, { name: 'Wool Sweater' });

    expect(db.reserveItem(item.id, 'Sarah', owner.id).status).toBe('owner_forbidden');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL with module `../src/server/db` not found.

- [ ] **Step 4: Implement `src/shared/types.ts` and `src/server/db.ts`**

Use `better-sqlite3` with WAL mode (`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`). Ensure `reserveItem` uses an atomic `UPDATE wishlist_items SET is_reserved = 1, reserved_by_name = ?, reserved_at = CURRENT_TIMESTAMP WHERE id = ? AND is_reserved = 0` check (`changes === 1`) so concurrent reservations never overwrite each other.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts src/shared/types.ts src/server/db.ts tests/db.test.ts
git commit -m "feat: add project scaffolding and SQLite data layer with spoiler protection"
```

---

### Task 2: Authentication & Multi-Provider OAuth 2.0 (`Google`, `Facebook`, `Amazon`) + Local Fallback

**Files:**
- Create: `src/server/auth.ts`
- Create: `src/server/routes/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `AppDatabase`, `User` from Task 1.
- Produces:
  - `src/server/auth.ts`:
    - `hashPassword(password: string): string` (using Node `crypto.scryptSync`)
    - `verifyPassword(password: string, storedHash: string): boolean`
    - `signSessionToken(userId: number, secret: string): string`
    - `verifySessionToken(token: string | undefined, secret: string): number | null`
    - `getConfiguredOAuthProviders(env?: NodeJS.ProcessEnv): { google: boolean; facebook: boolean; amazon: boolean }`
    - `buildOAuthAuthorizeUrl(provider: 'google' | 'facebook' | 'amazon', state: string, env?: NodeJS.ProcessEnv): string`
  - `src/server/routes/auth.ts`:
    - `createAuthRouter(db: AppDatabase, options?: { sessionSecret?: string; oauthExchangeFn?: OAuthExchangeFn }): express.Router`
    - `attachUserMiddleware(db: AppDatabase, sessionSecret?: string): express.RequestHandler`

- [ ] **Step 1: Write the failing auth tests in `tests/auth.test.ts`**

```typescript
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
    app.use('/api/auth', createAuthRouter(db, {
      sessionSecret: 'test-secret',
      oauthExchangeFn: async (provider, code) => ({
        provider,
        provider_account_id: `${provider}-${code}`,
        email: `${provider}@example.com`,
        display_name: `${provider.toUpperCase()} User`,
      }),
    }));
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL with module `../src/server/auth` not found.

- [ ] **Step 3: Implement `src/server/auth.ts` and `src/server/routes/auth.ts`**

Support OAuth 2.0 endpoints for:
- **Google:** `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, userinfo `https://www.googleapis.com/oauth2/v3/userinfo`
- **Facebook:** `https://www.facebook.com/v19.0/dialog/oauth`, token `https://graph.facebook.com/v19.0/oauth/access_token`, userinfo `https://graph.facebook.com/me?fields=id,name,email,picture`
- **Amazon ("Login with Amazon"):** `https://www.amazon.com/ap/oa` (`scope=profile`), token `https://api.amazon.com/auth/o2/token`, userinfo `https://api.amazon.com/user/profile`
And auto-create a default wishlist (`<DisplayName>'s Wishlist`) when a new user registers or signs in via OAuth for the first time.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/server/auth.ts src/server/routes/auth.ts tests/auth.test.ts
git commit -m "feat: add Google, Facebook, and Amazon OAuth 2.0 plus local auth fallback"
```

---

### Task 3: Multi-Layer Product URL Fetcher (`Amazon`, `Walmart`, `Target`, `Best Buy`, `Kohl's`)

**Files:**
- Create: `src/server/fetcher.ts`
- Test: `tests/fetcher.test.ts`

**Interfaces:**
- Consumes: `FetchedProductMetadata` from `src/shared/types.ts`.
- Produces:
  - `src/server/fetcher.ts`:
    - `validateSafeExternalUrl(rawUrl: string): URL` (throws `UnsafeUrlError` on non-http(s), `localhost`, `127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `[::1]`)
    - `normalizePrice(rawPrice: string | number | null | undefined): string | null`
    - `parseProductHtml(html: string, sourceUrl: string): FetchedProductMetadata`
    - `fetchProductMetadata(url: string, options?: { fetchFn?: typeof fetch }): Promise<FetchedProductMetadata>`

- [ ] **Step 1: Write the failing fetcher tests in `tests/fetcher.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseProductHtml, validateSafeExternalUrl, normalizePrice, fetchProductMetadata } from '../src/server/fetcher';

describe('Product URL Fetcher', () => {
  it('extracts Amazon title, price, image, color, size, and model from Amazon DOM', () => {
    const html = `
      <html>
        <body>
          <span id="productTitle">  Hurley Men's 5-Pack Stretch Boxer Briefs  </span>
          <div id="corePriceDisplay_desktop_feature_div">
            <span class="a-price"><span class="a-offscreen">$19.74</span></span>
          </div>
          <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/71hurley.jpg" src="https://m.media-amazon.com/images/I/thumb.jpg" />
          <div id="variation_color_name"><span class="selection">Blue Flamingo Combo</span></div>
          <div id="variation_size_name"><span class="selection">Medium</span></div>
          <table id="productDetails_techSpec_section_1">
            <tr><th>Item model number</th><td>HRL-5PK-M</td></tr>
          </table>
        </body>
      </html>
    `;
    const meta = parseProductHtml(html, 'https://www.amazon.com/dp/B0FW1J41WF');
    expect(meta.name).toBe("Hurley Men's 5-Pack Stretch Boxer Briefs");
    expect(meta.price).toBe('$19.74');
    expect(meta.image_url).toBe('https://m.media-amazon.com/images/I/71hurley.jpg');
    expect(meta.color).toBe('Blue Flamingo Combo');
    expect(meta.size).toBe('Medium');
    expect(meta.model).toBe('HRL-5PK-M');
    expect(meta.store_name).toBe('Amazon');
    expect(meta.partial).toBe(false);
  });

  it('extracts schema.org/Product JSON-LD (Target, Best Buy, Kohls) and resolves relative image URLs and bare prices', () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Product",
                  "name": "KitchenAid Artisan 5-Qt Stand Mixer",
                  "image": ["/images/mixer-pistachio.jpg"],
                  "color": "Pistachio",
                  "size": "5 Quart",
                  "model": "KSM150PS",
                  "offers": {
                    "@type": "Offer",
                    "price": 349.99,
                    "priceCurrency": "USD"
                  }
                }
              ]
            }
          </script>
        </head>
      </html>
    `;
    const meta = parseProductHtml(html, 'https://www.target.com/p/kitchenaid/-/A-12345');
    expect(meta.name).toBe('KitchenAid Artisan 5-Qt Stand Mixer');
    expect(meta.price).toBe('$349.99');
    expect(meta.image_url).toBe('https://www.target.com/images/mixer-pistachio.jpg');
    expect(meta.color).toBe('Pistachio');
    expect(meta.size).toBe('5 Quart');
    expect(meta.model).toBe('KSM150PS');
    expect(meta.store_name).toBe('Target');
  });

  it('extracts Walmart __NEXT_DATA__ initialData.data.product payload', () => {
    const nextData = {
      props: {
        pageProps: {
          initialData: {
            data: {
              product: {
                name: 'LEGO Star Wars Millennium Falcon',
                priceInfo: { currentPrice: { price: 169.99 } },
                imageInfo: { thumbnailUrl: 'https://i5.walmartimages.com/falcon.jpg' },
                model: '75257',
              },
            },
          },
        },
      },
    };
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></head></html>`;
    const meta = parseProductHtml(html, 'https://www.walmart.com/ip/12345');
    expect(meta.name).toBe('LEGO Star Wars Millennium Falcon');
    expect(meta.price).toBe('$169.99');
    expect(meta.image_url).toBe('https://i5.walmartimages.com/falcon.jpg');
    expect(meta.model).toBe('75257');
    expect(meta.store_name).toBe('Walmart');
  });

  it('rejects private/loopback SSRF URLs and normalizes prices', () => {
    expect(() => validateSafeExternalUrl('http://127.0.0.1:8080/admin')).toThrow();
    expect(() => validateSafeExternalUrl('http://192.168.1.1/router')).toThrow();
    expect(() => validateSafeExternalUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => validateSafeExternalUrl('file:///etc/passwd')).toThrow();
    expect(normalizePrice('47.48')).toBe('$47.48');
    expect(normalizePrice('$139.99')).toBe('$139.99');
  });

  it('returns graceful partial metadata when a store blocks scraping or returns 403', async () => {
    const result = await fetchProductMetadata('https://www.bestbuy.com/site/sony-tv/654321.p', {
      fetchFn: async () => new Response('Access Denied', { status: 403 }),
    });
    expect(result.url).toBe('https://www.bestbuy.com/site/sony-tv/654321.p');
    expect(result.partial).toBe(true);
    expect(result.store_name).toBe('Best Buy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fetcher.test.ts`
Expected: FAIL with module `../src/server/fetcher` not found.

- [ ] **Step 3: Implement `src/server/fetcher.ts`**

Implement `validateSafeExternalUrl`, `normalizePrice`, `parseProductHtml` (layering JSON-LD `Product` / `AggregateOffer`, `__NEXT_DATA__`, Amazon selectors including `#productTitle`, `#landingImage`, `#imgBlkFront`, `data-a-dynamic-image`, `#variation_color_name`, `#variation_size_name`, OpenGraph `og:title`/`og:image`/`product:price:amount`, plus URL slug fallback name when blocked), and `fetchProductMetadata`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fetcher.test.ts`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add src/server/fetcher.ts tests/fetcher.test.ts
git commit -m "feat: add multi-store product URL fetcher with SSRF protection"
```

---

### Task 4: *Things To Get Me* (`thingstogetme.com`) List Importer

**Files:**
- Create: `src/server/ttgm-importer.ts`
- Test: `tests/ttgm-importer.test.ts`

**Interfaces:**
- Consumes: `AppDatabase`, `TtgmImportSummary` from Task 1; `fetchProductMetadata`, `normalizePrice` from Task 3.
- Produces:
  - `src/server/ttgm-importer.ts`:
    - `cleanTtgmNote(rawNote: string): { size: string | null; color: string | null; model: string | null }`
    - `parseTtgmHtml(html: string): { title: string; items: TtgmRawItem[] }`
    - `importTtgmList(db: AppDatabase, wishlistId: number, urlOrCode: string, options?: { fetchHtmlFn?: (url: string) => Promise<string>; enrichFn?: typeof fetchProductMetadata }): Promise<TtgmImportSummary>`

- [ ] **Step 1: Write the failing TTGM importer tests in `tests/ttgm-importer.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase, AppDatabase } from '../src/server/db';
import { cleanTtgmNote, parseTtgmHtml, importTtgmList } from '../src/server/ttgm-importer';

const SAMPLE_TTGM_HTML = `
<!DOCTYPE html>
<html>
<head>
<script>
window.ttgmList = ${JSON.stringify({
  name: 'Blake Christmas',
  key: '902589a87070',
  items: [
    {
      key: 'item-received-past',
      name: 'Remote Start Kit Toyota Tundra',
      price: '$179.99',
      url: 'https://www.amazon.com/dp/B0868CBQ85',
      image: 'https://www.thingstogetme.com/public/images/tundra.jpg',
      note: '> medium, >  Needs    1      has    0',
      received: '2025-12-25 20:26:07',
      item_users: [{ key: 'u1', received: '2025-12-25 20:26:07' }],
    },
    {
      key: 'item-active-reserved',
      name: 'DC Power Supply Variable (30V 10A)',
      price: '47.48',
      url: 'https://www.amazon.com/dp/B0CN989377',
      image: 'https://www.thingstogetme.com/public/images/psu.jpg',
      note: 'Size : Encoder knob, Style : 30V 10A, > medium, >  Needs    1      has    0',
      received: null,
      item_users: [{ key: 'active-res-1', received: null, visitor: { key: 'v123' } }],
    },
    {
      key: 'item-missing-image',
      name: "Hurley Men's 5-Pack Stretch Boxer Briefs",
      price: '19.74',
      url: 'https://www.amazon.com/dp/B0FW1J41WF',
      image: '',
      note: 'Size: Medium, Color: Blue Flamingo',
      received: null,
      item_users: [],
    },
  ],
})};
</script>
</head>
</html>
`;

describe('Things To Get Me Importer', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  it('cleans legacy Amazon-import boilerplate from TTGM notes and extracts size/color', () => {
    const cleaned = cleanTtgmNote('Size : Encoder knob, Style : 30V 10A, > medium, >  Needs    1      has    0');
    expect(cleaned.size).toBe('Encoder knob');
    expect(cleaned.model).toBe('Style : 30V 10A');
  });

  it('skips received items, migrates active reservations spoiler-free, and auto-fetches missing photos', async () => {
    const owner = db.createUser({ email: 'blake@example.com', display_name: 'Blake' });
    const list = db.createWishlist(owner.id, { title: 'Blake Christmas' });

    const summary = await importTtgmList(db, list.id, '902589a87070', {
      fetchHtmlFn: async () => SAMPLE_TTGM_HTML,
      enrichFn: async (url) => ({
        url,
        name: "Hurley Men's 5-Pack Stretch Boxer Briefs",
        price: '$19.74',
        image_url: 'https://m.media-amazon.com/images/I/hurley.jpg',
        color: 'Blue Flamingo Combo',
        size: 'Medium',
        model: null,
        store_name: 'Amazon',
        partial: false,
      }),
    });

    expect(summary.skipped_received_count).toBe(1);
    expect(summary.imported_count).toBe(2);
    expect(summary.enriched_count).toBe(1);
    // Owner summary items must NOT leak reservation state
    expect(summary.items.every((i) => i.is_reserved === false)).toBe(true);

    // Guest view verifies the active reservation WAS migrated and missing photo WAS enriched
    const guestView = db.getWishlistView(list.slug, null)!;
    const psu = guestView.items.find((i) => i.name.includes('DC Power Supply'))!;
    expect(psu.is_reserved).toBe(true);
    expect(psu.reserved_by_name).toBe('Reserved (Imported)');
    expect(psu.price).toBe('$47.48');

    const hurley = guestView.items.find((i) => i.name.includes('Hurley'))!;
    expect(hurley.is_reserved).toBe(false);
    expect(hurley.image_url).toBe('https://m.media-amazon.com/images/I/hurley.jpg');
    expect(hurley.size).toBe('Medium');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ttgm-importer.test.ts`
Expected: FAIL with module `../src/server/ttgm-importer` not found.

- [ ] **Step 3: Implement `src/server/ttgm-importer.ts`**

Accept either a full `https://www.thingstogetme.com/<code>` URL or a bare alphanumeric code `902589a87070`. Extract `window.ttgmList` or `window.list` JSON, filter out `item.received !== null`, normalize prices (`"19.74"` -> `"$19.74"`), clean `item.note`, call `enrichFn` when `item.url` is present and `!item.image || !item.price`, insert into `db`, and return a spoiler-free `TtgmImportSummary`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ttgm-importer.test.ts`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/server/ttgm-importer.ts tests/ttgm-importer.test.ts
git commit -m "feat: add Things To Get Me list importer with auto-enrichment"
```

---

### Task 5: Express API Server & OpenGraph Messenger Preview Route

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `AppDatabase` (Task 1), `createAuthRouter`/`attachUserMiddleware` (Task 2), `fetchProductMetadata` (Task 3), `importTtgmList` (Task 4).
- Produces:
  - `src/server/app.ts`:
    - `createApp(options?: { db?: AppDatabase; sessionSecret?: string; fetchMetadataFn?: typeof fetchProductMetadata; importTtgmFn?: typeof importTtgmList }): express.Express`
    - Endpoints:
      - `GET /api/health` -> `{ status: 'ok' }`
      - `GET /api/family` -> `{ wishlists: Wishlist[] }`
      - `GET /api/wishlists` (auth required) -> `{ wishlists: Wishlist[] }`
      - `POST /api/wishlists` (auth required) -> `{ wishlist: Wishlist }`
      - `GET /api/wishlists/:slug` (public) -> `WishlistViewResponse` (spoiler-free if owner)
      - `PATCH /api/wishlists/:slug` & `DELETE /api/wishlists/:slug` (owner required)
      - `POST /api/wishlists/:slug/items` (owner required) -> `{ item: WishlistItem }`
      - `PATCH /api/wishlists/:slug/items/:itemId` & `DELETE /api/wishlists/:slug/items/:itemId` (owner required)
      - `POST /api/items/:itemId/reserve` (public/guest allowed, body `{ reserved_by_name?: string }`) -> `200 { item }` or `400`/`403`/`409`
      - `POST /api/items/:itemId/unreserve` (public/guest allowed) -> `200 { item }` or `403`
      - `POST /api/fetch-url` (auth required, body `{ url: string }`) -> `FetchedProductMetadata`
      - `POST /api/wishlists/:slug/import-ttgm` (owner required, body `{ urlOrCode: string }`) -> `TtgmImportSummary`
      - `GET /w/:slug` (HTML request) -> serves SPA HTML with `<meta property="og:title" content="<Wishlist Title>">` and `<meta property="og:description" content="View <Owner>'s wishlist and reserve gifts spoiler-free.">`

- [ ] **Step 1: Write the failing API integration tests in `tests/api.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDatabase, AppDatabase } from '../src/server/db';
import { createApp } from '../src/server/app';

describe('Wishlist API & OpenGraph', () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp({ db, sessionSecret: 'test-secret' });
  });

  it('supports full owner item creation, guest viewing, guest reservation without login, and owner spoiler protection', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'sarah@example.com', password: 'password123', display_name: 'Sarah' });
    const ownerCookie = reg.headers['set-cookie'];

    const listsRes = await request(app).get('/api/wishlists').set('Cookie', ownerCookie);
    const slug = listsRes.body.wishlists[0].slug;

    const addRes = await request(app)
      .post(`/api/wishlists/${slug}/items`)
      .set('Cookie', ownerCookie)
      .send({
        name: 'KitchenAid Mixer',
        price: '$349.99',
        url: 'https://www.target.com/p/mixer',
        color: 'Pistachio',
        size: '5 Qt',
      });
    expect(addRes.status).toBe(201);
    const itemId = addRes.body.item.id;

    // Guest reserves without any cookie/login
    const reserveRes = await request(app)
      .post(`/api/items/${itemId}/reserve`)
      .send({ reserved_by_name: 'Aunt Linda' });
    expect(reserveRes.status).toBe(200);
    expect(reserveRes.body.item.is_reserved).toBe(true);
    expect(reserveRes.body.item.reserved_by_name).toBe('Aunt Linda');

    // Second guest trying to reserve gets 409 Conflict
    const conflictRes = await request(app)
      .post(`/api/items/${itemId}/reserve`)
      .send({ reserved_by_name: 'Uncle Bob' });
    expect(conflictRes.status).toBe(409);

    // Owner fetching their own wishlist sees is_reserved = false
    const ownerView = await request(app).get(`/api/wishlists/${slug}`).set('Cookie', ownerCookie);
    expect(ownerView.body.is_owner).toBe(true);
    expect(ownerView.body.items[0].is_reserved).toBe(false);
    expect(ownerView.body.items[0].reserved_by_name).toBeNull();

    // OpenGraph meta tags rendered on /w/:slug for Facebook Messenger
    const ogRes = await request(app).get(`/w/${slug}`).set('Accept', 'text/html');
    expect(ogRes.status).toBe(200);
    expect(ogRes.text).toContain('property="og:title"');
    expect(ogRes.text).toContain("Sarah&#39;s Wishlist");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api.test.ts`
Expected: FAIL with module `../src/server/app` not found.

- [ ] **Step 3: Implement `src/server/app.ts` and `src/server/index.ts`**

Implement all routes in `src/server/app.ts` and the server entrypoint in `src/server/index.ts`. Escape HTML entities in OpenGraph meta tag values to prevent XSS.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts src/server/index.ts tests/api.test.ts
git commit -m "feat: add Express API routes and OpenGraph share metadata"
```

---

### Task 6: Dark-Theme React Frontend (`Creator View`, `Visitor Available/Reserved Tabs`, `URL Fetcher & TTGM Import Modal`)

**Files:**
- Create: `index.html`
- Create: `tailwind.config.js`
- Create: `postcss.config.js`
- Create: `src/client/index.css`
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/components/Navbar.tsx`
- Create: `src/client/components/ItemFormModal.tsx`
- Create: `src/client/components/TtgmImportModal.tsx`
- Create: `src/client/components/WishlistView.tsx`
- Test: `tests/frontend.test.tsx`

**Interfaces:**
- Consumes: Shared types from `src/shared/types.ts` and REST endpoints from Task 5.
- Produces:
  - `WishlistView` component (`props: { data: WishlistViewResponse; currentUser: User | null; onRefresh: () => void; onAddItem?: () => void; onEditItem?: (item: WishlistItem) => void; onDeleteItem?: (itemId: number) => void; onOpenImport?: () => void }`)
  - `ItemFormModal` component (`props: { wishlistSlug: string; initialItem?: WishlistItem | null; prefillFromQuery?: Partial<FetchedProductMetadata> | null; onClose: () => void; onSaved: () => void }`)
  - `TtgmImportModal` component (`props: { wishlistSlug: string; onClose: () => void; onImported: (summary: TtgmImportSummary) => void }`)

- [ ] **Step 1: Write the failing frontend tests in `tests/frontend.test.tsx`**

```tsx
// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WishlistView } from '../src/client/components/WishlistView';
import { ItemFormModal } from '../src/client/components/ItemFormModal';
import { WishlistViewResponse } from '../src/shared/types';

const sampleVisitorData: WishlistViewResponse = {
  wishlist: {
    id: 1,
    user_id: 10,
    owner_name: 'Sarah',
    slug: 'sarah-holiday',
    title: "Sarah's Holiday Wishlist",
    description: 'Sizes and links inside!',
    is_public: true,
    created_at: '2026-10-31',
    updated_at: '2026-10-31',
  },
  is_owner: false,
  items: [
    {
      id: 101,
      wishlist_id: 1,
      name: 'Merino Wool Sweater',
      url: 'https://www.kohls.com/sweater',
      price: '$59.50',
      image_url: null,
      color: 'Navy',
      size: 'Medium',
      model: null,
      priority: 0,
      is_reserved: false,
      reserved_by_name: null,
      reserved_at: null,
      created_at: '2026-10-31',
      updated_at: '2026-10-31',
    },
    {
      id: 102,
      wishlist_id: 1,
      name: 'KitchenAid Stand Mixer',
      url: 'https://www.target.com/mixer',
      price: '$349.99',
      image_url: null,
      color: 'Pistachio',
      size: '5 Quart',
      model: 'KSM150PS',
      priority: 0,
      is_reserved: true,
      reserved_by_name: 'Uncle Bob',
      reserved_at: '2026-10-31',
      created_at: '2026-10-31',
      updated_at: '2026-10-31',
    },
  ],
};

describe('Wishlist Frontend Views', () => {
  it('renders Available and Reserved tabs for visitors, hiding reserved items from Available tab to reduce clutter', () => {
    render(<WishlistView data={sampleVisitorData} currentUser={null} onRefresh={vi.fn()} />);

    // Available tab is active by default and shows only unreserved item
    expect(screen.getByText(/Available \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Reserved \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('Merino Wool Sweater')).toBeInTheDocument();
    expect(screen.queryByText('KitchenAid Stand Mixer')).not.toBeInTheDocument();

    // Clicking Reserved tab shows the reserved item and who reserved it
    fireEvent.click(screen.getByText(/Reserved \(1\)/i));
    expect(screen.getByText('KitchenAid Stand Mixer')).toBeInTheDocument();
    expect(screen.getByText(/Reserved by Uncle Bob/i)).toBeInTheDocument();
  });

  it('hides Available/Reserved tabs completely when is_owner is true (Creator View)', () => {
    const ownerData: WishlistViewResponse = {
      ...sampleVisitorData,
      is_owner: true,
      items: sampleVisitorData.items.map((i) => ({ ...i, is_reserved: false, reserved_by_name: null })),
    };
    render(<WishlistView data={ownerData} currentUser={{ id: 10, email: 's@e.com', display_name: 'Sarah', avatar_url: null, created_at: '' }} onRefresh={vi.fn()} />);

    expect(screen.queryByText(/Reserved \(/i)).not.toBeInTheDocument();
    expect(screen.getByText('Merino Wool Sweater')).toBeInTheDocument();
    expect(screen.getByText('KitchenAid Stand Mixer')).toBeInTheDocument();
  });

  it('uses dark background and light text classes on form inputs in ItemFormModal', () => {
    render(<ItemFormModal wishlistSlug="sarah-holiday" onClose={vi.fn()} onSaved={vi.fn()} />);
    const urlInput = screen.getByPlaceholderText(/Paste product link/i);
    expect(urlInput.className).toContain('bg-slate-900');
    expect(urlInput.className).toContain('text-slate-50');
    expect(urlInput.className).not.toContain('bg-white');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frontend.test.tsx`
Expected: FAIL with module `../src/client/components/WishlistView` not found.

- [ ] **Step 3: Implement the React frontend (`index.html`, Tailwind config, and `src/client/*`)**

Ensure:
- Every `<input>` and `<textarea>` uses `bg-slate-900 text-slate-50 placeholder-slate-400 border border-slate-700 focus:border-blue-500`.
- `WishlistView` shows:
  - **Visitor View (`!data.is_owner`):** Two tabs (`Available (N)` and `Reserved (M)`), guest inline name input (`Your name to reserve`, pre-filled from `currentUser?.display_name || localStorage.getItem('wishlist_guest_name')`), `Reserve` button, and in the `Reserved` tab `Reserved by <Name>` + `Unreserve` button.
  - **Owner View (`data.is_owner`):** `+ Add Item` button, `Import from Things To Get Me` button, `Copy Link for Messenger` button, draggable `+ Add to Wishlist` bookmarklet link, and Edit/Delete item controls with zero reservation indicators.
- `App.tsx` supports `?addUrl=...&title=...&price=...&image=...` query parameters so the browser bookmarklet opens the Add Item modal pre-populated.

- [ ] **Step 4: Run test to verify it passes and build the frontend bundle**

Run: `npx vitest run && npm run build`
Expected: PASS (all unit, integration, and frontend tests pass; Vite and TypeScript build cleanly).

- [ ] **Step 5: Commit**

```bash
git add index.html tailwind.config.js postcss.config.js src/client tests/frontend.test.tsx
git commit -m "feat: add dark-theme React frontend with guest reservation tabs and TTGM import UI"
```

---

### Task 7: Unraid Docker Packaging & Documentation

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `unraid-template.xml`
- Create: `README.md`
- Test: `tests/deployment-config.test.ts`

**Interfaces:**
- Consumes: Built server and client artifacts from Tasks 1–6.
- Produces: Production Docker container configuration listening on `PORT=3000` with `/data` persistent volume, `.env.example`, and `unraid-template.xml`.

- [ ] **Step 1: Write the failing deployment configuration test in `tests/deployment-config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Unraid & Docker Deployment Artifacts', () => {
  const root = path.resolve(__dirname, '..');

  it('provides Dockerfile, docker-compose.yml, .env.example, and valid Unraid XML template mapping /data', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain('EXPOSE 3000');

    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('/data');
    expect(compose).toContain('GOOGLE_CLIENT_ID');
    expect(compose).toContain('FACEBOOK_CLIENT_ID');
    expect(compose).toContain('AMAZON_CLIENT_ID');

    const unraidXml = fs.readFileSync(path.join(root, 'unraid-template.xml'), 'utf8');
    expect(unraidXml).toContain('<Container version="2">');
    expect(unraidXml).toContain('/mnt/user/appdata/family-wishlist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/deployment-config.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '.../Dockerfile'`.

- [ ] **Step 3: Create `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `unraid-template.xml`, and `README.md`**

Include clear Unraid setup instructions, `/mnt/user/appdata/family-wishlist:/data` volume mapping, and step-by-step instructions for configuring Google, Facebook, and Login with Amazon OAuth callback URLs (`<APP_URL>/api/auth/oauth/<provider>/callback`).

- [ ] **Step 4: Run full test suite to verify everything passes**

Run: `npx vitest run`
Expected: PASS (all test files pass)

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example unraid-template.xml README.md tests/deployment-config.test.ts
git commit -m "chore: add Unraid Docker template, Dockerfile, and deployment docs"
```
