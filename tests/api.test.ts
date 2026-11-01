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
  });
});
