import type { AppDatabase } from './db.js';
import type { TtgmImportSummary, WishlistItem } from '../shared/types.js';
import {
  downloadImageBlob,
  fetchProductMetadata,
  normalizePrice,
  validateSafeExternalUrl,
} from './fetcher.js';

export interface TtgmRawSection {
  key?: string;
  name?: string;
  sequence?: number;
  items?: TtgmRawItem[];
}

export interface TtgmRawItem {
  key?: string;
  name: string;
  section?: string | null;
  section_name?: string | null;
  sequence?: number;
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
    sections?: TtgmRawSection[];
    items?: TtgmRawItem[];
  };

  const sectionInfo = new Map<string, { name: string; sequence: number }>();
  if (Array.isArray(parsed.sections)) {
    for (const sec of parsed.sections) {
      if (sec && sec.key && sec.name?.trim()) {
        sectionInfo.set(sec.key, {
          name: sec.name.trim(),
          sequence: Number(sec.sequence ?? 0),
        });
      }
    }
  }

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const indexed = rawItems.map((it, idx) => {
    const sec = it.section ? sectionInfo.get(it.section) : undefined;
    return {
      item: {
        ...it,
        section_name: sec ? sec.name : null,
      },
      sectionSeq: sec ? sec.sequence : Number.MAX_SAFE_INTEGER,
      itemSeq: it.sequence !== undefined ? Number(it.sequence) : idx,
      originalIdx: idx,
    };
  });

  if (sectionInfo.size > 0) {
    indexed.sort((a, b) => {
      if (a.sectionSeq !== b.sectionSeq) return a.sectionSeq - b.sectionSeq;
      if (a.itemSeq !== b.itemSeq) return a.itemSeq - b.itemSeq;
      return a.originalIdx - b.originalIdx;
    });
  }

  return {
    title: parsed.name?.trim() || 'Imported Wishlist',
    items: indexed.map((entry) => entry.item),
  };
}

export async function importTtgmList(
  db: AppDatabase,
  wishlistId: number,
  urlOrCode: string,
  options?: {
    fetchHtmlFn?: (url: string) => Promise<string>;
    enrichFn?: typeof fetchProductMetadata;
    downloadImageFn?: typeof downloadImageBlob;
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
  // In real runtime (when neither fetchHtmlFn nor enrichFn is mocked, or when downloadImageFn is explicitly passed), cache images as SQLite BLOBs
  const downloadImg =
    options?.downloadImageFn ??
    (!options?.fetchHtmlFn && !options?.enrichFn ? downloadImageBlob : undefined);

  const html = await fetchHtml(targetUrl);
  const { items: rawItems } = parseTtgmHtml(html);

  let skipped_received_count = 0;
  let enriched_count = 0;

  const activeRawItems: TtgmRawItem[] = [];
  for (const raw of rawItems) {
    if (raw.received !== null && raw.received !== undefined && String(raw.received).trim() !== '') {
      skipped_received_count++;
      continue;
    }
    activeRawItems.push(raw);
  }

  interface PreparedImportItem {
    name: string;
    section: string | null;
    url: string | null;
    price: string | null;
    image_url: string | null;
    cachedBlob: { blob: Uint8Array; mimeType: string } | null;
    color: string | null;
    size: string | null;
    model: string | null;
    priority: number;
    activeReservation: boolean;
    didEnrich: boolean;
  }

  const prepared: PreparedImportItem[] = new Array(activeRawItems.length);
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < activeRawItems.length) {
      const idx = cursor++;
      const raw = activeRawItems[idx];

      const itemUrl = raw.url?.trim() || null;
      let itemPrice = normalizePrice(raw.price);
      let itemImage: string | null = null;
      let ttgmFallbackImageUrl: string | null = null;

      if (raw.image?.trim()) {
        try {
          const resolved = new URL(raw.image.trim(), targetUrl);
          const imgHost = resolved.hostname.toLowerCase();
          if (imgHost === 'thingstogetme.com' || imgHost.endsWith('.thingstogetme.com')) {
            // Never hotlink thingstogetme.com; only use for one-time local BLOB download if store scraping fails
            ttgmFallbackImageUrl = resolved.toString();
          } else {
            itemImage = resolved.toString();
          }
        } catch {
          itemImage = null;
        }
      }

      const noteFields = cleanTtgmNote(raw.note);
      let itemColor = noteFields.color;
      let itemSize = noteFields.size;
      let itemModel = noteFields.model;
      let didEnrich = false;

      // Auto-fetch missing details if the item has a URL but is missing direct store image or price
      if (itemUrl && (!itemImage || !itemPrice)) {
        try {
          const meta = await enrich(itemUrl);
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
        } catch {
          // Ignore enrichment errors and keep existing item data
        }
      }

      // Download image into local SQLite BLOB cache so we never hammer 3rd-party servers or hotlink TTGM
      let cachedBlob: { blob: Uint8Array; mimeType: string } | null = null;
      if (downloadImg) {
        const sourceToDownload = itemImage || ttgmFallbackImageUrl;
        if (sourceToDownload) {
          try {
            cachedBlob = await downloadImg(sourceToDownload);
            if (!itemImage && cachedBlob) {
              didEnrich = true;
            }
          } catch {
            cachedBlob = null;
          }
        }
      }

      const activeReservation = Array.isArray(raw.item_users) && raw.item_users.length > 0;
      const cleanName = (raw.name || 'Untitled Item').replace(/^Amazon\.com\s*:\s*/i, '').trim();

      prepared[idx] = {
        name: cleanName,
        section: raw.section_name ?? null,
        url: itemUrl,
        price: itemPrice,
        image_url: itemImage,
        cachedBlob,
        color: itemColor,
        size: itemSize,
        model: itemModel,
        priority: Number(raw.priority ?? 0),
        activeReservation,
        didEnrich,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, activeRawItems.length) }, () => worker())
  );

  const importedOwnerSafeItems: WishlistItem[] = [];
  for (const p of prepared) {
    if (p.didEnrich) enriched_count++;
    let created = db.addItem(wishlistId, {
      name: p.name,
      section: p.section,
      url: p.url,
      price: p.price,
      image_url: p.image_url,
      color: p.color,
      size: p.size,
      model: p.model,
      priority: p.priority,
      is_reserved: p.activeReservation,
      reserved_by_name: p.activeReservation ? 'Reserved (Imported)' : null,
    });

    if (p.cachedBlob) {
      created = db.setItemImageBlob(created.id, p.cachedBlob.blob, p.cachedBlob.mimeType) || created;
    }

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
