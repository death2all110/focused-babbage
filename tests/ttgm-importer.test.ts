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
