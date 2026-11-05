import type { AppDatabase } from './db.js';
import type { TtgmImportSummary, WishlistItem } from '../shared/types.js';
import {
  assertSafeResolvedHostname,
  downloadImageBlob,
  fetchProductMetadata,
  normalizePrice,
  readResponseBytesWithLimit,
  sanitizeHttpUrl,
  validateSafeExternalUrl,
} from './fetcher.js';

const MAX_TTGM_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TTGM_IMPORT_ITEMS = 5000;

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
  const host = parsed.hostname.toLowerCase();
  if (host !== 'thingstogetme.com' && !host.endsWith('.thingstogetme.com')) {
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
  const seenKeys = new Set<string>();
  const uniqueRawItems: TtgmRawItem[] = [];
  for (const it of rawItems) {
    const key = it.key?.trim();
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    uniqueRawItems.push(it);
  }

  const indexed = uniqueRawItems.map((it, idx) => {
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
    autoProcessEnrichment?: boolean;
  }
): Promise<TtgmImportSummary> {
  const targetUrl = resolveTtgmUrl(urlOrCode);
  const fetchHtml =
    options?.fetchHtmlFn ||
    (async (u: string) => {
      let currentUrl = resolveTtgmUrl(u);
      let res: Response | null = null;

      for (let hop = 0; hop < 3; hop++) {
        const parsedHop = new URL(currentUrl);
        await assertSafeResolvedHostname(parsedHop.hostname);

        res = await fetch(currentUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(12000),
        });

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) break;
          currentUrl = resolveTtgmUrl(new URL(loc, currentUrl).toString());
          continue;
        }
        break;
      }

      if (!res || !res.ok) {
        throw new Error(`Failed to fetch Things To Get Me list (HTTP ${res?.status ?? 0})`);
      }
      const bytes = await readResponseBytesWithLimit(res, MAX_TTGM_HTML_BYTES);
      if (!bytes) {
        throw new Error('Things To Get Me list response exceeded maximum size limit.');
      }
      return new TextDecoder().decode(bytes);
    });

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
    if (activeRawItems.length < MAX_TTGM_IMPORT_ITEMS) {
      activeRawItems.push(raw);
    }
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
    needsEnrichment: boolean;
  }

  const prepared: PreparedImportItem[] = new Array(activeRawItems.length);
  const concurrency = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < activeRawItems.length) {
      const idx = cursor++;
      const raw = activeRawItems[idx];

      let itemUrl: string | null = null;
      if (raw.url?.trim()) {
        try {
          itemUrl = sanitizeHttpUrl(raw.url.trim());
        } catch {
          itemUrl = null;
        }
      }
      let itemPrice = normalizePrice(raw.price);
      let itemImage: string | null = null;

      if (raw.image?.trim()) {
        try {
          const resolved = new URL(raw.image.trim(), targetUrl);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
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

      // Download image directly into local SQLite BLOB cache
      let cachedBlob: { blob: Uint8Array; mimeType: string } | null = null;
      if (downloadImg && itemImage) {
        try {
          cachedBlob = await downloadImg(itemImage);
        } catch {
          cachedBlob = null;
        }
      }

      const hasImage = Boolean(cachedBlob || itemImage);
      const hasPrice = Boolean(itemPrice);
      const needsEnrichment = Boolean(itemUrl && (!hasImage || !hasPrice));

      const activeReservation = Array.isArray(raw.item_users) && raw.item_users.length > 0;
      const cleanName = (raw.name || 'Untitled Item')
        .replace(/^Amazon\.com\s*:\s*/i, '')
        .trim()
        .slice(0, 300);

      prepared[idx] = {
        name: cleanName,
        section: raw.section_name ? raw.section_name.slice(0, 100) : null,
        url: itemUrl,
        price: itemPrice,
        image_url: itemImage,
        cachedBlob,
        color: itemColor ? itemColor.slice(0, 100) : null,
        size: itemSize ? itemSize.slice(0, 100) : null,
        model: itemModel ? itemModel.slice(0, 500) : null,
        priority: Number(raw.priority ?? 0),
        activeReservation,
        needsEnrichment,
      };
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, activeRawItems.length) }, () => worker())
  );

  const importedOwnerSafeItems: WishlistItem[] = [];
  for (const p of prepared) {
    let created = db.upsertItem(wishlistId, {
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
      needs_enrichment: p.needsEnrichment,
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

  if (options?.autoProcessEnrichment) {
    const enrichResult = await processPendingEnrichments(db, wishlistId, {
      enrichFn: options.enrichFn,
      downloadImageFn: options.downloadImageFn,
    });
    enriched_count = enrichResult.succeeded;
    const refreshedWishlist = db.getWishlistById(wishlistId);
    const refreshedView = refreshedWishlist
      ? db.getWishlistView(refreshedWishlist.slug, refreshedWishlist.user_id)
      : undefined;
    const refreshedItems = refreshedView?.items || [];
    return {
      imported_count: refreshedItems.length,
      skipped_received_count,
      enriched_count,
      items: refreshedItems,
    };
  }

  return {
    imported_count: importedOwnerSafeItems.length,
    skipped_received_count,
    enriched_count,
    items: importedOwnerSafeItems,
  };
}

export async function processPendingEnrichments(
  db: AppDatabase,
  wishlistId?: number,
  options?: {
    enrichFn?: typeof fetchProductMetadata;
    downloadImageFn?: typeof downloadImageBlob;
    delayBetweenItemsMs?: number;
  }
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const enrich = options?.enrichFn || fetchProductMetadata;
  const downloadImg = options?.downloadImageFn || downloadImageBlob;
  const delayMs = options?.delayBetweenItemsMs ?? (process.env.NODE_ENV === 'test' ? 0 : 500);

  const pendingItems = db.getPendingEnrichmentItems(wishlistId);
  let succeeded = 0;
  let failed = 0;

  for (const item of pendingItems) {
    if (!item.url) {
      db.clearNeedsEnrichment(item.id);
      continue;
    }

    try {
      const meta = await enrich(item.url);
      let nextImage = item.image_url;
      let cachedBlob: { blob: Uint8Array; mimeType: string } | null = null;

      if (!item.image_url && meta.image_url) {
        nextImage = meta.image_url;
        try {
          cachedBlob = await downloadImg(meta.image_url);
        } catch {
          cachedBlob = null;
        }
      }

      db.updateItem(item.id, item.wishlist_id, {
        price: item.price || meta.price,
        image_url: nextImage,
        color: item.color || meta.color,
        size: item.size || meta.size,
        model: item.model || meta.model,
      });

      if (cachedBlob) {
        db.setItemImageBlob(item.id, cachedBlob.blob, cachedBlob.mimeType);
      }
      succeeded++;
    } catch {
      failed++;
    } finally {
      // Unconditionally clear the flag as instructed by the user
      db.clearNeedsEnrichment(item.id);
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { processed: pendingItems.length, succeeded, failed };
}
