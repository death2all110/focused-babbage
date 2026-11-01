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
    const cleaned = cleanTtgmNote(
      'Size : Encoder knob, Style : 30V 10A, > medium, >  Needs    1      has    0'
    );
    expect(cleaned.size).toBe('Encoder knob');
    expect(cleaned.model).toBe('Style : 30V 10A');
  });

  it('skips received items, migrates active reservations spoiler-free, and auto-fetches missing photos', async () => {
    const owner = db.createUser({ email: 'blake@example.com', display_name: 'Blake' });
    const list = db.createWishlist(owner.id, { title: 'Blake Christmas' });

    const summary = await importTtgmList(db, list.id, '902589a87070', {
      fetchHtmlFn: async () => SAMPLE_TTGM_HTML,
      enrichFn: async (url) => {
        if (url.includes('B0CN989377')) {
          return {
            url,
            name: 'DC Power Supply Variable (30V 10A)',
            price: '$47.48',
            image_url: 'https://m.media-amazon.com/images/I/psu-direct.jpg',
            color: null,
            size: 'Encoder knob',
            model: '30V 10A',
            store_name: 'Amazon',
            partial: false,
          };
        }
        return {
          url,
          name: "Hurley Men's 5-Pack Stretch Boxer Briefs",
          price: '$19.74',
          image_url: 'https://m.media-amazon.com/images/I/hurley.jpg',
          color: 'Blue Flamingo Combo',
          size: 'Medium',
          model: null,
          store_name: 'Amazon',
          partial: false,
        };
      },
    });

    expect(summary.skipped_received_count).toBe(1);
    expect(summary.imported_count).toBe(2);
    expect(summary.enriched_count).toBe(2);
    // Owner summary items must NOT leak reservation state
    expect(summary.items.every((i) => i.is_reserved === false)).toBe(true);

    // Guest view verifies the active reservation WAS migrated and direct store photos WERE fetched (no thingstogetme.com hotlinking)
    const guestView = db.getWishlistView(list.slug, null)!;
    const psu = guestView.items.find((i) => i.name.includes('DC Power Supply'))!;
    expect(psu.is_reserved).toBe(true);
    expect(psu.reserved_by_name).toBe('Reserved (Imported)');
    expect(psu.price).toBe('$47.48');
    expect(psu.image_url).toBe('https://m.media-amazon.com/images/I/psu-direct.jpg');
    expect(psu.image_url).not.toContain('thingstogetme.com');

    const hurley = guestView.items.find((i) => i.name.includes('Hurley'))!;
    expect(hurley.is_reserved).toBe(false);
    expect(hurley.image_url).toBe('https://m.media-amazon.com/images/I/hurley.jpg');
    expect(hurley.size).toBe('Medium');
  });

  it('discards relative or absolute thingstogetme.com image URLs and fetches from the store instead', async () => {
    const owner = db.createUser({ email: 'blake2@example.com', display_name: 'Blake' });
    const list = db.createWishlist(owner.id, { title: 'Blake Christmas' });

    const htmlWithTtgmImg = `
      <script>
      window.ttgmList = ${JSON.stringify({
        name: 'Blake Christmas',
        items: [
          {
            key: 'rel-img-item',
            name: 'Relative Image Item',
            price: '$25.00',
            url: 'https://www.amazon.com/dp/B000123',
            image: '/public/images/url/sample.jpg',
            note: '',
            received: null,
            item_users: [],
          },
        ],
      })};
      </script>
    `;

    const summary = await importTtgmList(db, list.id, '902589a87070', {
      fetchHtmlFn: async () => htmlWithTtgmImg,
      enrichFn: async (url) => ({
        url,
        name: 'Relative Image Item',
        price: '$25.00',
        image_url: 'https://m.media-amazon.com/images/I/direct-store.jpg',
        color: null,
        size: null,
        model: null,
        store_name: 'Amazon',
        partial: false,
      }),
    });
    expect(summary.items[0].image_url).toBe(
      'https://m.media-amazon.com/images/I/direct-store.jpg'
    );
  });

  it('preserves Things To Get Me sections in sequence order and caches images locally as SQLite BLOBs', async () => {
    const owner = db.createUser({ email: 'char@example.com', display_name: 'Char' });
    const list = db.createWishlist(owner.id, { title: "Char's Wishes 2026" });

    const htmlWithSections = `
      <script>
      window.ttgmList = ${JSON.stringify({
        name: "Char's Wishes 2026",
        sections: [
          { key: 'sec-books', name: 'Books', sequence: 20 },
          { key: 'sec-decor', name: 'Bedroom Decor', sequence: 10 },
        ],
        items: [
          {
            key: 'item-book',
            name: 'Unicorn vs. Goblins',
            section: 'sec-books',
            sequence: 10,
            price: '$12.99',
            url: 'https://www.barnesandnoble.com/w/unicorn/1123?ean=9781449476281',
            image: '',
            received: null,
            item_users: [],
          },
          {
            key: 'item-decor',
            name: 'Softball Bedding Set',
            section: 'sec-decor',
            sequence: 10,
            price: '$54.14',
            url: 'https://www.walmart.com/ip/softball/12345',
            image: 'https://www.thingstogetme.com/public/images/item-uploads/custom-bedding.jpg',
            received: null,
            item_users: [],
          },
        ],
      })};
      </script>
    `;

    const downloadedUrls: string[] = [];
    const summary = await importTtgmList(db, list.id, '2330693a0f17e', {
      fetchHtmlFn: async () => htmlWithSections,
      enrichFn: async (url) => {
        if (url.includes('barnesandnoble.com')) {
          return {
            url,
            name: 'Unicorn vs. Goblins',
            price: '$12.99',
            image_url: 'https://covers.openlibrary.org/b/isbn/9781449476281-L.jpg',
            color: null,
            size: null,
            model: null,
            store_name: 'Barnes & Noble',
            partial: false,
          };
        }
        // Simulate store blocking scraping (no store image returned)
        return {
          url,
          name: 'Softball Bedding Set',
          price: null,
          image_url: null,
          color: null,
          size: null,
          model: null,
          store_name: 'Walmart',
          partial: true,
        };
      },
      downloadImageFn: async (imgUrl) => {
        downloadedUrls.push(imgUrl);
        return {
          blob: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: 'image/png',
        };
      },
    });

    expect(summary.imported_count).toBe(2);
    // Ordered by section sequence: Bedroom Decor (10) first, Books (20) second
    expect(summary.items[0].name).toBe('Softball Bedding Set');
    expect(summary.items[0].section).toBe('Bedroom Decor');
    expect(summary.items[0].image_url).toBe(`/api/items/${summary.items[0].id}/image`);

    expect(summary.items[1].name).toBe('Unicorn vs. Goblins');
    expect(summary.items[1].section).toBe('Books');
    expect(summary.items[1].image_url).toBe(`/api/items/${summary.items[1].id}/image`);

    // Verify the custom TTGM upload was downloaded once into SQLite BLOB cache when store scraping failed
    expect(downloadedUrls).toContain(
      'https://www.thingstogetme.com/public/images/item-uploads/custom-bedding.jpg'
    );
    expect(db.getItemImageBlob(summary.items[0].id)).toBeDefined();
    expect(db.getItemImageBlob(summary.items[1].id)).toBeDefined();
  });
});
