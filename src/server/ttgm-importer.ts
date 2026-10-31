import type { AppDatabase } from './db.js';
import type { TtgmImportSummary, WishlistItem } from '../shared/types.js';
import { fetchProductMetadata, normalizePrice, validateSafeExternalUrl } from './fetcher.js';

export interface TtgmRawItem {
  key?: string;
  name: string;
  price?: string | number | null;
  url?: string | null;
  image?: string | null;
  note?: string | null;
  received?: string | null;
  priority?: number;
  item_users?: Array<{
    key?: string;
    received?: string | null;
    user?: { name?: string; key?: string } | null;
    visitor?: { name?: string; key?: string } | null;
  }>;
}

export function cleanTtgmNote(rawNote: string | null | undefined): {
  size: string | null;
  color: string | null;
  model: string | null;
} {
  if (!rawNote) return { size: null, color: null, model: null };

  // Remove legacy Amazon import suffix like "> medium, >  Needs    1      has    0"
  const stripped = rawNote
    .replace(/,?\s*>\s*(?:lowest|low|medium|high|highest)\s*,?\s*>\s*Needs\s+\d+\s+has\s+\d+/gi, '')
    .trim()
    .replace(/^,+|,+$/g, '')
    .trim();

  if (!stripped) return { size: null, color: null, model: null };

  let size: string | null = null;
  let color: string | null = null;
  const remainingParts: string[] = [];

  const parts = stripped.split(/\s*,\s*/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const sizeMatch = trimmed.match(/^size\s*:?\s*(.+)$/i);
    if (sizeMatch && !size) {
      size = sizeMatch[1].trim();
      continue;
    }

    const colorMatch = trimmed.match(/^colou?r\s*:?\s*(.+)$/i);
    if (colorMatch && !color) {
      color = colorMatch[1].trim();
      continue;
    }

    remainingParts.push(trimmed);
  }

  return {
    size,
    color,
    model: remainingParts.length > 0 ? remainingParts.join(', ') : null,
  };
}

export function resolveTtgmUrl(urlOrCode: string): string {
  const trimmed = urlOrCode.trim();
  if (/^[a-z0-9]{6,24}$/i.test(trimmed)) {
    return `https://www.thingstogetme.com/${trimmed}`;
  }
  const parsed = validateSafeExternalUrl(trimmed);
  if (!parsed.hostname.toLowerCase().endsWith('thingstogetme.com')) {
    throw new Error('Only thingstogetme.com URLs or list codes are supported.');
  }
  return parsed.toString();
}

export function parseTtgmHtml(html: string): { title: string; items: TtgmRawItem[] } {
  const match =
    html.match(/window\.ttgmList\s*=\s*(\{[\s\S]*?\});\s*\n/) ||
    html.match(/window\.list\s*=\s*(\{[\s\S]*?\});\s*\n/);

  if (!match) {
    throw new Error('Could not find Things To Get Me list data on that page.');
  }

  const parsed = JSON.parse(match[1]) as {
    name?: string;
    items?: TtgmRawItem[];
  };

  return {
    title: parsed.name?.trim() || 'Imported Wishlist',
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

export async function importTtgmList(
  db: AppDatabase,
  wishlistId: number,
  urlOrCode: string,
  options?: {
    fetchHtmlFn?: (url: string) => Promise<string>;
    enrichFn?: typeof fetchProductMetadata;
  }
): Promise<TtgmImportSummary> {
  const targetUrl = resolveTtgmUrl(urlOrCode);
  const fetchHtml =
    options?.fetchHtmlFn ||
    (async (u: string) => {
      const res = await fetch(u, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch Things To Get Me list (HTTP ${res.status})`);
      }
      return res.text();
    });

  const enrich = options?.enrichFn || fetchProductMetadata;
  const html = await fetchHtml(targetUrl);
  const { items: rawItems } = parseTtgmHtml(html);

  let skipped_received_count = 0;
  let enriched_count = 0;
  const importedOwnerSafeItems: WishlistItem[] = [];

  for (const raw of rawItems) {
    // Skip items marked as received in past holidays
    if (raw.received !== null && raw.received !== undefined && String(raw.received).trim() !== '') {
      skipped_received_count++;
      continue;
    }

    const itemUrl = raw.url?.trim() || null;
    let itemPrice = normalizePrice(raw.price);
    let itemImage = raw.image?.trim() || null;
    const noteFields = cleanTtgmNote(raw.note);
    let itemColor = noteFields.color;
    let itemSize = noteFields.size;
    let itemModel = noteFields.model;

    // Auto-fetch missing details if the item has a URL but is missing image or price
    if (itemUrl && (!itemImage || !itemPrice)) {
      try {
        const meta = await enrich(itemUrl);
        let didEnrich = false;
        if (!itemImage && meta.image_url) {
          itemImage = meta.image_url;
          didEnrich = true;
        }
        if (!itemPrice && meta.price) {
          itemPrice = meta.price;
          didEnrich = true;
        }
        if (!itemColor && meta.color) {
          itemColor = meta.color;
          didEnrich = true;
        }
        if (!itemSize && meta.size) {
          itemSize = meta.size;
          didEnrich = true;
        }
        if (!itemModel && meta.model) {
          itemModel = meta.model;
          didEnrich = true;
        }
        if (didEnrich) {
          enriched_count++;
        }
      } catch {
        // Ignore enrichment errors and keep existing item data
      }
    }

    const activeReservation = Array.isArray(raw.item_users) && raw.item_users.length > 0;
    const cleanName = (raw.name || 'Untitled Item').replace(/^Amazon\.com\s*:\s*/i, '').trim();

    const created = db.addItem(wishlistId, {
      name: cleanName,
      url: itemUrl,
      price: itemPrice,
      image_url: itemImage,
      color: itemColor,
      size: itemSize,
      model: itemModel,
      priority: Number(raw.priority ?? 0),
      is_reserved: activeReservation,
      reserved_by_name: activeReservation ? 'Reserved (Imported)' : null,
    });

    // Strip reservation state from the returned summary so the list owner never gets spoiled
    importedOwnerSafeItems.push({
      ...created,
      is_reserved: false,
      reserved_by_name: null,
      reserved_at: null,
    });
  }

  return {
    imported_count: importedOwnerSafeItems.length,
    skipped_received_count,
    enriched_count,
    items: importedOwnerSafeItems,
  };
}
