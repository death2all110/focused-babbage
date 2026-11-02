import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { User, Wishlist, WishlistItem, WishlistViewResponse } from '../shared/types.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export interface AppDatabase {
  createUser(input: {
    email: string;
    display_name: string;
    password_hash?: string | null;
    avatar_url?: string | null;
  }): User;
  getUserByEmail(email: string): (User & { password_hash: string | null }) | undefined;
  getUserById(id: number): User | undefined;
  upsertOAuthUser(input: {
    provider: 'google' | 'facebook' | 'amazon';
    provider_account_id: string;
    email: string;
    display_name: string;
    avatar_url?: string | null;
  }): User;
  createWishlist(
    userId: number,
    input: { title: string; description?: string; slug?: string; is_public?: boolean }
  ): Wishlist;
  getUserWishlists(userId: number): Wishlist[];
  getPublicWishlists(): Wishlist[];
  getWishlistBySlug(slug: string): Wishlist | undefined;
  getWishlistById(id: number): Wishlist | undefined;
  updateWishlist(
    id: number,
    userId: number,
    input: Partial<{ title: string; description: string; is_public: boolean }>
  ): Wishlist | undefined;
  deleteWishlist(id: number, userId: number): boolean;
  addItem(
    wishlistId: number,
    input: {
      name: string;
      section?: string | null;
      url?: string | null;
      price?: string | null;
      image_url?: string | null;
      color?: string | null;
      size?: string | null;
      model?: string | null;
      priority?: number;
      is_reserved?: boolean;
      reserved_by_name?: string | null;
    }
  ): WishlistItem;
  setItemImageBlob(itemId: number, blob: Uint8Array, mimeType: string): WishlistItem | undefined;
  getItemImageBlob(itemId: number): { blob: Uint8Array; mimeType: string } | undefined;
  updateItem(
    itemId: number,
    wishlistId: number,
    input: Partial<
      Omit<
        WishlistItem,
        'id' | 'wishlist_id' | 'is_reserved' | 'reserved_by_name' | 'reserved_at' | 'created_at' | 'updated_at'
      >
    >
  ): WishlistItem | undefined;
  deleteItem(itemId: number, wishlistId: number): boolean;
  getWishlistView(slug: string, viewerUserId: number | null): WishlistViewResponse | undefined;
  reserveItem(
    itemId: number,
    reservedByName: string,
    viewerUserId?: number | null
  ):
    | { status: 'ok'; item: WishlistItem }
    | { status: 'not_found' }
    | { status: 'already_reserved' }
    | { status: 'owner_forbidden' }
    | { status: 'invalid_name' };
  unreserveItem(
    itemId: number,
    viewerUserId?: number | null
  ):
    | { status: 'ok'; item: WishlistItem }
    | { status: 'not_found' }
    | { status: 'owner_forbidden' };
}

function generateSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = crypto.randomBytes(4).toString('hex');
  return base ? `${base}-${suffix}` : suffix;
}

function mapWishlistRow(row: Record<string, unknown>): Wishlist {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    owner_name: String(row.owner_name ?? ''),
    slug: String(row.slug),
    title: String(row.title),
    description: String(row.description ?? ''),
    is_public: Boolean(row.is_public),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapItemRow(row: Record<string, unknown>, hideReservation = false): WishlistItem {
  return {
    id: Number(row.id),
    wishlist_id: Number(row.wishlist_id),
    name: String(row.name),
    section: row.section != null && String(row.section).trim() !== '' ? String(row.section) : null,
    url: row.url != null ? String(row.url) : null,
    price: row.price != null ? String(row.price) : null,
    image_url: row.image_url != null ? String(row.image_url) : null,
    color: row.color != null ? String(row.color) : null,
    size: row.size != null ? String(row.size) : null,
    model: row.model != null ? String(row.model) : null,
    priority: Number(row.priority ?? 0),
    is_reserved: hideReservation ? false : Boolean(row.is_reserved),
    reserved_by_name: hideReservation ? null : row.reserved_by_name != null ? String(row.reserved_by_name) : null,
    reserved_at: hideReservation ? null : row.reserved_at != null ? String(row.reserved_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function createDatabase(dbPath?: string): AppDatabase {
  const resolvedPath =
    dbPath ?? path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), 'wishlist.db');

  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const sqlite = new DatabaseSync(resolvedPath);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oauth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_account_id)
    );

    CREATE TABLE IF NOT EXISTS wishlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_public INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wishlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      section TEXT,
      url TEXT,
      price TEXT,
      image_url TEXT,
      image_blob BLOB,
      image_mime TEXT,
      color TEXT,
      size TEXT,
      model TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      is_reserved INTEGER NOT NULL DEFAULT 0,
      reserved_by_name TEXT,
      reserved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const existingCols = new Set(
    (sqlite.prepare('PRAGMA table_info(wishlist_items)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  if (!existingCols.has('section')) {
    sqlite.exec('ALTER TABLE wishlist_items ADD COLUMN section TEXT;');
  }
  if (!existingCols.has('image_blob')) {
    sqlite.exec('ALTER TABLE wishlist_items ADD COLUMN image_blob BLOB;');
  }
  if (!existingCols.has('image_mime')) {
    sqlite.exec('ALTER TABLE wishlist_items ADD COLUMN image_mime TEXT;');
  }

  const db: AppDatabase = {
    createUser(input) {
      const normalizedEmail = input.email.trim().toLowerCase();
      const stmt = sqlite.prepare(`
        INSERT INTO users (email, display_name, password_hash, avatar_url)
        VALUES (?, ?, ?, ?)
      `);
      const res = stmt.run(
        normalizedEmail,
        input.display_name.trim(),
        input.password_hash ?? null,
        input.avatar_url ?? null
      );
      return this.getUserById(Number(res.lastInsertRowid))!;
    },

    getUserByEmail(email) {
      const row = sqlite
        .prepare('SELECT id, email, display_name, avatar_url, password_hash, created_at FROM users WHERE email = ?')
        .get(email.trim().toLowerCase()) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: Number(row.id),
        email: String(row.email),
        display_name: String(row.display_name),
        avatar_url: row.avatar_url != null ? String(row.avatar_url) : null,
        password_hash: row.password_hash != null ? String(row.password_hash) : null,
        created_at: String(row.created_at),
      };
    },

    getUserById(id) {
      const row = sqlite
        .prepare('SELECT id, email, display_name, avatar_url, created_at FROM users WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: Number(row.id),
        email: String(row.email),
        display_name: String(row.display_name),
        avatar_url: row.avatar_url != null ? String(row.avatar_url) : null,
        created_at: String(row.created_at),
      };
    },

    upsertOAuthUser(input) {
      const existingOAuth = sqlite
        .prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_account_id = ?')
        .get(input.provider, input.provider_account_id) as { user_id: number } | undefined;

      if (existingOAuth) {
        return this.getUserById(Number(existingOAuth.user_id))!;
      }

      const normalizedEmail = input.email.trim().toLowerCase();
      let user = this.getUserByEmail(normalizedEmail);
      if (!user) {
        const created = this.createUser({
          email: normalizedEmail,
          display_name: input.display_name,
          avatar_url: input.avatar_url ?? null,
        });
        user = { ...created, password_hash: null };
      } else if (user.password_hash !== null) {
        // Prevent pre-auth account takeover: clear any unverified local password when linking OAuth
        sqlite.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(user.id);
      }

      sqlite
        .prepare('INSERT INTO oauth_accounts (user_id, provider, provider_account_id) VALUES (?, ?, ?)')
        .run(user.id, input.provider, input.provider_account_id);

      return this.getUserById(user.id)!;
    },

    createWishlist(userId, input) {
      const slug = input.slug?.trim() || generateSlug(input.title);
      const isPublic = input.is_public === undefined ? 1 : input.is_public ? 1 : 0;
      const res = sqlite
        .prepare('INSERT INTO wishlists (user_id, slug, title, description, is_public) VALUES (?, ?, ?, ?, ?)')
        .run(userId, slug, input.title.trim(), (input.description ?? '').trim(), isPublic);
      return this.getWishlistById(Number(res.lastInsertRowid))!;
    },

    getUserWishlists(userId) {
      const rows = sqlite
        .prepare(`
          SELECT w.*, u.display_name AS owner_name
          FROM wishlists w
          JOIN users u ON u.id = w.user_id
          WHERE w.user_id = ?
          ORDER BY w.created_at DESC, w.id DESC
        `)
        .all(userId) as Record<string, unknown>[];
      return rows.map(mapWishlistRow);
    },

    getPublicWishlists() {
      const rows = sqlite
        .prepare(`
          SELECT w.*, u.display_name AS owner_name
          FROM wishlists w
          JOIN users u ON u.id = w.user_id
          WHERE w.is_public = 1
          ORDER BY w.updated_at DESC, w.id DESC
        `)
        .all() as Record<string, unknown>[];
      return rows.map(mapWishlistRow);
    },

    getWishlistBySlug(slug) {
      const row = sqlite
        .prepare(`
          SELECT w.*, u.display_name AS owner_name
          FROM wishlists w
          JOIN users u ON u.id = w.user_id
          WHERE w.slug = ?
        `)
        .get(slug) as Record<string, unknown> | undefined;
      return row ? mapWishlistRow(row) : undefined;
    },

    getWishlistById(id) {
      const row = sqlite
        .prepare(`
          SELECT w.*, u.display_name AS owner_name
          FROM wishlists w
          JOIN users u ON u.id = w.user_id
          WHERE w.id = ?
        `)
        .get(id) as Record<string, unknown> | undefined;
      return row ? mapWishlistRow(row) : undefined;
    },

    updateWishlist(id, userId, input) {
      const existing = this.getWishlistById(id);
      if (!existing || existing.user_id !== userId) return undefined;

      const title = input.title !== undefined ? input.title.trim() : existing.title;
      const description = input.description !== undefined ? input.description.trim() : existing.description;
      const isPublic = input.is_public !== undefined ? (input.is_public ? 1 : 0) : existing.is_public ? 1 : 0;

      sqlite
        .prepare(`
          UPDATE wishlists
          SET title = ?, description = ?, is_public = ?, updated_at = datetime('now')
          WHERE id = ? AND user_id = ?
        `)
        .run(title, description, isPublic, id, userId);

      return this.getWishlistById(id);
    },

    deleteWishlist(id, userId) {
      const res = sqlite.prepare('DELETE FROM wishlists WHERE id = ? AND user_id = ?').run(id, userId);
      return Number(res.changes) > 0;
    },

    addItem(wishlistId, input) {
      const isReserved = input.is_reserved ? 1 : 0;
      const reservedByName = isReserved ? (input.reserved_by_name?.trim() || 'Reserved') : null;
      const reservedAt = isReserved ? new Date().toISOString() : null;
      const sectionVal = input.section?.trim() || null;

      const res = sqlite
        .prepare(`
          INSERT INTO wishlist_items (
            wishlist_id, name, section, url, price, image_url, color, size, model, priority,
            is_reserved, reserved_by_name, reserved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          wishlistId,
          input.name.trim(),
          sectionVal,
          input.url ?? null,
          input.price ?? null,
          input.image_url ?? null,
          input.color ?? null,
          input.size ?? null,
          input.model ?? null,
          input.priority ?? 0,
          isReserved,
          reservedByName,
          reservedAt
        );

      const row = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE id = ?')
        .get(Number(res.lastInsertRowid)) as Record<string, unknown>;
      return mapItemRow(row, false);
    },

    setItemImageBlob(itemId, blob, mimeType) {
      const existing = sqlite
        .prepare('SELECT id FROM wishlist_items WHERE id = ?')
        .get(itemId) as Record<string, unknown> | undefined;
      if (!existing) return undefined;

      const localUrl = `/api/items/${itemId}/image`;
      sqlite
        .prepare(`
          UPDATE wishlist_items
          SET image_blob = ?, image_mime = ?, image_url = ?, updated_at = datetime('now')
          WHERE id = ?
        `)
        .run(blob, mimeType, localUrl, itemId);

      const updated = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE id = ?')
        .get(itemId) as Record<string, unknown>;
      return mapItemRow(updated, false);
    },

    getItemImageBlob(itemId) {
      const row = sqlite
        .prepare('SELECT image_blob, image_mime FROM wishlist_items WHERE id = ?')
        .get(itemId) as { image_blob?: Uint8Array | null; image_mime?: string | null } | undefined;
      if (!row || !row.image_blob) return undefined;
      return {
        blob: new Uint8Array(row.image_blob),
        mimeType: row.image_mime || 'image/jpeg',
      };
    },

    updateItem(itemId, wishlistId, input) {
      const existing = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE id = ? AND wishlist_id = ?')
        .get(itemId, wishlistId) as Record<string, unknown> | undefined;
      if (!existing) return undefined;

      const current = mapItemRow(existing, false);
      const nextSection =
        input.section !== undefined ? (input.section?.trim() || null) : current.section;
      sqlite
        .prepare(`
          UPDATE wishlist_items
          SET name = ?, section = ?, url = ?, price = ?, image_url = ?, color = ?, size = ?, model = ?, priority = ?, updated_at = datetime('now')
          WHERE id = ? AND wishlist_id = ?
        `)
        .run(
          input.name !== undefined ? input.name.trim() : current.name,
          nextSection,
          input.url !== undefined ? input.url : current.url,
          input.price !== undefined ? input.price : current.price,
          input.image_url !== undefined ? input.image_url : current.image_url,
          input.color !== undefined ? input.color : current.color,
          input.size !== undefined ? input.size : current.size,
          input.model !== undefined ? input.model : current.model,
          input.priority !== undefined ? input.priority : current.priority,
          itemId,
          wishlistId
        );

      if (input.image_url === null) {
        sqlite
          .prepare(`
            UPDATE wishlist_items
            SET image_blob = NULL, image_mime = NULL
            WHERE id = ? AND wishlist_id = ?
          `)
          .run(itemId, wishlistId);
      }

      const updated = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE id = ?')
        .get(itemId) as Record<string, unknown>;
      return mapItemRow(updated, false);
    },

    deleteItem(itemId, wishlistId) {
      const res = sqlite
        .prepare('DELETE FROM wishlist_items WHERE id = ? AND wishlist_id = ?')
        .run(itemId, wishlistId);
      return Number(res.changes) > 0;
    },

    getWishlistView(slug, viewerUserId) {
      const wishlist = this.getWishlistBySlug(slug);
      if (!wishlist) return undefined;

      const isOwner = viewerUserId != null && viewerUserId === wishlist.user_id;
      const rows = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE wishlist_id = ? ORDER BY priority DESC, id ASC')
        .all(wishlist.id) as Record<string, unknown>[];

      return {
        wishlist,
        is_owner: isOwner,
        items: rows.map((row) => mapItemRow(row, isOwner)),
      };
    },

    reserveItem(itemId, reservedByName, viewerUserId = null) {
      const trimmedName = reservedByName?.trim() ?? '';
      if (!trimmedName) {
        return { status: 'invalid_name' };
      }

      const row = sqlite
        .prepare(`
          SELECT i.*, w.user_id AS owner_id
          FROM wishlist_items i
          JOIN wishlists w ON w.id = i.wishlist_id
          WHERE i.id = ?
        `)
        .get(itemId) as (Record<string, unknown> & { owner_id: number }) | undefined;

      if (!row) {
        return { status: 'not_found' };
      }

      if (viewerUserId != null && Number(row.owner_id) === viewerUserId) {
        return { status: 'owner_forbidden' };
      }

      const updateRes = sqlite
        .prepare(`
          UPDATE wishlist_items
          SET is_reserved = 1, reserved_by_name = ?, reserved_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND is_reserved = 0
        `)
        .run(trimmedName, itemId);

      if (Number(updateRes.changes) === 0) {
        return { status: 'already_reserved' };
      }

      const updated = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE id = ?')
        .get(itemId) as Record<string, unknown>;
      return { status: 'ok', item: mapItemRow(updated, false) };
    },

    unreserveItem(itemId, viewerUserId = null) {
      const row = sqlite
        .prepare(`
          SELECT i.*, w.user_id AS owner_id
          FROM wishlist_items i
          JOIN wishlists w ON w.id = i.wishlist_id
          WHERE i.id = ?
        `)
        .get(itemId) as (Record<string, unknown> & { owner_id: number }) | undefined;

      if (!row) {
        return { status: 'not_found' };
      }

      if (viewerUserId != null && Number(row.owner_id) === viewerUserId) {
        return { status: 'owner_forbidden' };
      }

      sqlite
        .prepare(`
          UPDATE wishlist_items
          SET is_reserved = 0, reserved_by_name = NULL, reserved_at = NULL, updated_at = datetime('now')
          WHERE id = ?
        `)
        .run(itemId);

      const updated = sqlite
        .prepare('SELECT * FROM wishlist_items WHERE id = ?')
        .get(itemId) as Record<string, unknown>;
      return { status: 'ok', item: mapItemRow(updated, false) };
    },
  };

  return db;
}
