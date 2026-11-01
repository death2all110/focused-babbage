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
});
