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

    // Local SQLite BLOB image serving via GET /api/items/:itemId/image
    const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    db.setItemImageBlob(itemId, samplePng, 'image/png');
    const imgRes = await request(app).get(`/api/items/${itemId}/image`);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers['content-type']).toMatch(/image\/png/);
    expect(new Uint8Array(imgRes.body)).toEqual(samplePng);

    // Built-in Privacy Policy & Data Deletion pages for Facebook/OAuth compliance
    const privacyRes = await request(app).get('/privacy');
    expect(privacyRes.status).toBe(200);
    expect(privacyRes.text).toContain('Privacy Policy');

    const deletionRes = await request(app).get('/data-deletion');
    expect(deletionRes.status).toBe(200);
    expect(deletionRes.text).toContain('User Data Deletion Instructions');
  });

  it('allows owner to delete their wishlist and cascades deletion of items', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@example.com', password: 'password123', display_name: 'Owner' });
    const ownerCookie = reg.headers['set-cookie'];

    const listsRes = await request(app).get('/api/wishlists').set('Cookie', ownerCookie);
    const slug = listsRes.body.wishlists[0].slug;

    // Add an item to the list
    const addRes = await request(app)
      .post(`/api/wishlists/${slug}/items`)
      .set('Cookie', ownerCookie)
      .send({ name: 'Test Item' });
    expect(addRes.status).toBe(201);
    const itemId = addRes.body.item.id;

    // Unauthorized delete fails
    const unauthDel = await request(app).delete(`/api/wishlists/${slug}`);
    expect(unauthDel.status).toBe(401);

    // Another user cannot delete the list
    const otherReg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'other@example.com', password: 'password123', display_name: 'Other' });
    const otherCookie = otherReg.headers['set-cookie'];
    const forbiddenDel = await request(app)
      .delete(`/api/wishlists/${slug}`)
      .set('Cookie', otherCookie);
    expect(forbiddenDel.status).toBe(403);

    // Owner deletes the list
    const deleteRes = await request(app)
      .delete(`/api/wishlists/${slug}`)
      .set('Cookie', ownerCookie);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // Wishlist is no longer found
    const getRes = await request(app).get(`/api/wishlists/${slug}`);
    expect(getRes.status).toBe(404);

    // Cascaded item deletion
    const itemRow = db.getItemImageBlob(itemId);
    expect(itemRow).toBeUndefined();
  });

  it('allows editing an item retaining local /api/items/:id/image and preserves BLOB', async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'editor@example.com', password: 'password123', display_name: 'Editor' });
    const ownerCookie = reg.headers['set-cookie'];

    const listsRes = await request(app).get('/api/wishlists').set('Cookie', ownerCookie);
    const slug = listsRes.body.wishlists[0].slug;

    // Add item and attach a local BLOB image
    const addRes = await request(app)
      .post(`/api/wishlists/${slug}/items`)
      .set('Cookie', ownerCookie)
      .send({ name: 'Vinyl Record', price: '$29.99' });
    expect(addRes.status).toBe(201);
    const itemId = addRes.body.item.id;

    const sampleJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    db.setItemImageBlob(itemId, sampleJpg, 'image/jpeg');

    // Update the item passing the local image URL (as sent by Edit Wishlist Item modal)
    const patchRes = await request(app)
      .patch(`/api/wishlists/${slug}/items/${itemId}`)
      .set('Cookie', ownerCookie)
      .send({
        name: 'Vinyl Record - Special Edition',
        price: '$34.99',
        image_url: `/api/items/${itemId}/image`,
      });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.item.name).toBe('Vinyl Record - Special Edition');
    expect(patchRes.body.item.price).toBe('$34.99');
    expect(patchRes.body.item.image_url).toBe(`/api/items/${itemId}/image`);

    // Verify the BLOB is still accessible and unchanged
    const imgRes = await request(app).get(`/api/items/${itemId}/image`);
    expect(imgRes.status).toBe(200);
    expect(new Uint8Array(imgRes.body)).toEqual(sampleJpg);
  });
});
