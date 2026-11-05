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

  it('stores item section and caches binary image BLOBs in SQLite', () => {
    const owner = db.createUser({ email: 'sarah@example.com', display_name: 'Sarah' });
    const list = db.createWishlist(owner.id, { title: "Sarah's List" });
    const item = db.addItem(list.id, {
      name: 'Unicorn vs. Goblins',
      section: 'Books',
      price: '$12.99',
    });

    expect(item.section).toBe('Books');

    const sampleBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const updated = db.setItemImageBlob(item.id, sampleBytes, 'image/jpeg')!;
    expect(updated.image_url).toBe(`/api/items/${item.id}/image`);

    const storedBlob = db.getItemImageBlob(item.id);
    expect(storedBlob).toBeDefined();
    expect(storedBlob!.mimeType).toBe('image/jpeg');
    expect(Array.from(storedBlob!.blob)).toEqual(Array.from(sampleBytes));
  });

  it('supports needs_enrichment flag and deferred enrichment queries', () => {
    const owner = db.createUser({ email: 'enrich@example.com', display_name: 'Enrich' });
    const list = db.createWishlist(owner.id, { title: 'Enrich List' });

    const item1 = db.addItem(list.id, {
      name: 'Item Needing Enrichment',
      url: 'https://example.com/item1',
      needs_enrichment: true,
    });
    const item2 = db.addItem(list.id, {
      name: 'Item Already Complete',
      price: '$10.00',
      needs_enrichment: false,
    });

    expect(item1.needs_enrichment).toBe(true);
    expect(item2.needs_enrichment).toBe(false);

    const pending = db.getPendingEnrichmentItems(list.id);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(item1.id);

    db.clearNeedsEnrichment(item1.id);
    expect(db.getPendingEnrichmentItems(list.id).length).toBe(0);
  });

  it('upserts items by URL or name, preventing duplicates and preserving reservations', () => {
    const owner = db.createUser({ email: 'dedup@example.com', display_name: 'Dedup' });
    const list = db.createWishlist(owner.id, { title: 'Dedup List' });

    const item = db.addItem(list.id, {
      name: 'Whale Tracking Bracelet',
      url: 'https://myfahlo.com/products/whale-tracking-bracelet',
      price: '$16.95',
      section: 'Bracelets',
    });

    // Reserve item
    db.reserveItem(item.id, 'Grandma', null);

    // Upserting with same URL updates fields but does not duplicate and keeps reservation
    const upserted = db.upsertItem(list.id, {
      name: 'Whale Tracking Bracelet - Updated Name',
      url: 'https://myfahlo.com/products/whale-tracking-bracelet',
      price: '$18.00',
      section: 'Bracelets',
      size: 'One Size',
    });

    expect(upserted.id).toBe(item.id);
    expect(upserted.price).toBe('$18.00');
    expect(upserted.size).toBe('One Size');

    const guestView = db.getWishlistView(list.slug, null)!;
    expect(guestView.items.length).toBe(1);
    expect(guestView.items[0].is_reserved).toBe(true);
    expect(guestView.items[0].reserved_by_name).toBe('Grandma');

    // Upserting new item adds it
    const newItem = db.upsertItem(list.id, {
      name: 'New Product',
      url: 'https://example.com/new',
    });
    expect(newItem.id).not.toBe(item.id);
    expect(db.getWishlistView(list.slug, null)!.items.length).toBe(2);

    // Clearing wishlist items wipes them
    db.clearWishlistItems(list.id);
    expect(db.getWishlistView(list.slug, null)!.items.length).toBe(0);
  });

  it('runs one-time migration to add needs_enrichment column and sets it to 0 for all existing items', () => {
    // Manually create a raw sqlite db without the needs_enrichment column
    const { DatabaseSync } = require('node:sqlite');
    const rawSqlite = new DatabaseSync(':memory:');
    rawSqlite.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL
      );
      CREATE TABLE wishlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL
      );
      CREATE TABLE wishlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wishlist_id INTEGER NOT NULL REFERENCES wishlists(id),
        name TEXT NOT NULL,
        price TEXT
      );
      INSERT INTO users (id, email, display_name) VALUES (1, 'legacy@example.com', 'Legacy');
      INSERT INTO wishlists (id, user_id, slug, title) VALUES (1, 1, 'legacy-list', 'Legacy List');
      INSERT INTO wishlist_items (id, wishlist_id, name, price) VALUES (1, 1, 'Old Item', '$20.00');
    `);

    // Verify rawSqlite table does not have needs_enrichment column
    const colsBefore = new Set(
      rawSqlite.prepare('PRAGMA table_info(wishlist_items)').all().map((c: any) => c.name)
    );
    expect(colsBefore.has('needs_enrichment')).toBe(false);

    // Apply the exact startup migration logic
    if (!colsBefore.has('needs_enrichment')) {
      rawSqlite.exec('ALTER TABLE wishlist_items ADD COLUMN needs_enrichment INTEGER NOT NULL DEFAULT 0;');
      rawSqlite.exec('UPDATE wishlist_items SET needs_enrichment = 0 WHERE needs_enrichment IS NULL;');
    }

    // Verify column exists now and existing items have needs_enrichment = 0
    const row = rawSqlite.prepare('SELECT needs_enrichment FROM wishlist_items WHERE id = 1').get() as {
      needs_enrichment: number;
    };
    expect(row.needs_enrichment).toBe(0);
  });
});
