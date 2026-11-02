import * as cheerio from 'cheerio';
import dns from 'node:dns';
import net from 'node:net';
import type { FetchedProductMetadata } from '../shared/types.js';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export const ALLOWED_RASTER_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    lower === '::' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('ff') ||
    lower.startsWith('2001:db8:')
  ) {
    return true;
  }

  if (lower.startsWith('::ffff:')) {
    const suffix = lower.slice(7);
    if (suffix.includes('.')) {
      return isPrivateIp(suffix);
    }
    const hexParts = suffix.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIp(ipv4);
      }
    }
  }

  // Block any other IPv6 address outside global unicast 2000::/3 (e.g. [::7f00:1] IPv4-compatible, NAT64 64:ff9b::, 6to4 2002::)
  if (lower.includes(':')) {
    if (!/^[23][0-9a-f]{3}:/i.test(lower) || lower.startsWith('2001:db8:') || lower.startsWith('2002:')) {
      return true;
    }
    return false;
  }

  const parts = lower.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b, c] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale 100.64.0.0/10
    if (a === 169 && b === 254) return true; // Link-local / Cloud Metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark 198.18.0.0/15
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true; // Multicast & Reserved
  }
  return false;
}

export function validateSafeExternalUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    throw new UnsafeUrlError('Invalid URL format.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new UnsafeUrlError('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are allowed.');
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'localtest.me' ||
    host.endsWith('.localtest.me') ||
    host === 'lvh.me' ||
    host.endsWith('.lvh.me') ||
    host.endsWith('.nip.io') ||
    host.endsWith('.sslip.io') ||
    host.endsWith('.xip.io')
  ) {
    throw new UnsafeUrlError('Localhost, internal, and wildcard rebinding hostnames are not allowed.');
  }

  if (net.isIP(host) && isPrivateIp(host)) {
    throw new UnsafeUrlError('Private or loopback IP addresses are not allowed.');
  }

  return parsed;
}

export async function assertSafeResolvedHostname(
  hostname: string,
  lookupFn: (host: string) => Promise<Array<{ address: string; family: number }>> = (h) =>
    dns.promises.lookup(h, { all: true })
): Promise<void> {
  const cleanHost = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(cleanHost)) {
    if (isPrivateIp(cleanHost)) {
      throw new UnsafeUrlError('Private or loopback IP addresses are not allowed.');
    }
    return;
  }

  const records = await lookupFn(cleanHost);
  if (!records || records.length === 0) {
    throw new UnsafeUrlError('Could not resolve hostname.');
  }
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new UnsafeUrlError('Hostname resolves to a private or reserved IP address.');
    }
  }
}

export function sanitizeHttpUrl(rawUrl: unknown): string | null {
  if (rawUrl === null || rawUrl === undefined) return null;
  if (typeof rawUrl !== 'string') {
    throw new UnsafeUrlError('URL must be a string.');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048) {
    throw new UnsafeUrlError('URL exceeds maximum length.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UnsafeUrlError('Invalid URL format.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are allowed.');
  }
  return parsed.toString();
}

export async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number
): Promise<Uint8Array | null> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return null;
  }

  if (!response.body) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return new Uint8Array(ab);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function normalizePrice(rawPrice: string | number | null | undefined): string | null {
  if (rawPrice === null || rawPrice === undefined) return null;
  const str = String(rawPrice).trim();
  if (!str) return null;

  // Match currency symbol + amount or bare decimal number
  const match = str.match(/([$£€])?\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/);
  if (!match) return null;
  const symbol = match[1] || '$';
  const numStr = match[2].replace(/,/g, '');
  const num = Number(numStr);
  if (Number.isNaN(num) || num <= 0) return null;
  return `${symbol}${num.toFixed(2)}`;
}

export function detectStoreName(urlStr: string): string | null {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (host.includes('amazon.') || host === 'a.co' || host === 'amzn.to') return 'Amazon';
    if (host.includes('target.com')) return 'Target';
    if (host.includes('walmart.com')) return 'Walmart';
    if (host.includes('bestbuy.com')) return 'Best Buy';
    if (host.includes('kohls.com')) return "Kohl's";
    if (host.includes('harborfreight.com')) return 'Harbor Freight';
    if (host.includes('gamestop.com')) return 'GameStop';
    if (host.includes('lowes.com')) return "Lowe's";
    if (host.includes('homedepot.com')) return 'Home Depot';
    if (host.includes('barnesandnoble.com')) return 'Barnes & Noble';
    if (host.includes('etsy.com')) return 'Etsy';
    if (host.includes('ebay.com')) return 'eBay';
    if (host.includes('newegg.com')) return 'Newegg';
    if (host.includes('wayfair.com')) return 'Wayfair';
    if (host.includes('nordstrom.com')) return 'Nordstrom';
    if (host.includes('nike.com')) return 'Nike';
    if (host.includes('apple.com')) return 'Apple';
    if (host.includes('costco.com')) return 'Costco';
    if (host.includes('ikea.com')) return 'IKEA';
    if (host.includes('chewy.com')) return 'Chewy';

    // Universal domain parsing for any other website in the world
    const cleanHost = host.replace(/^www\./, '');
    const parts = cleanHost.split('.');
    if (parts.length >= 2) {
      let domain = parts[0];
      if (parts.length >= 3 && (parts[parts.length - 2] === 'co' || parts[parts.length - 2] === 'com')) {
        domain = parts[parts.length - 3];
      } else if (parts.length >= 3 && domain === 'shop') {
        domain = parts[1];
      }
      return domain
        .replace(/[-_+]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }
    return null;
  } catch {
    return null;
  }
}

function resolveUrlMaybe(candidate: string | null | undefined, baseUrl: string): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.startsWith('data:')) return null;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    const str = resolved.toString();
    // Ignore Amazon global marketing/logo sprites (/images/G/)
    if (str.includes('media-amazon.com/images/G/')) return null;
    return str;
  } catch {
    return null;
  }
}

function canonicalizeFetchUrl(safeUrl: URL): string {
  const host = safeUrl.hostname.toLowerCase();
  if (host.includes('amazon.')) {
    const asinMatch = safeUrl.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (asinMatch) {
      return `${safeUrl.protocol}//${safeUrl.host}/dp/${asinMatch[1].toUpperCase()}`;
    }
  }
  return safeUrl.toString();
}

function extractSlugFallbackTitle(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    const segments = u.pathname
      .split('/')
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length > 3 &&
          s !== 'dp' &&
          s !== 'gp' &&
          s !== 'product' &&
          s !== 'site' &&
          s !== 'ip' &&
          s !== 'p' &&
          !s.toLowerCase().startsWith('ref=') &&
          !/^[A-Z0-9]{10}$/.test(s) &&
          !/^A-\d+$/.test(s) &&
          !/^\d+(\.p|\.html)?$/.test(s)
      );
    if (segments.length === 0) return '';
    const best = segments.sort((a, b) => b.length - a.length)[0];
    return decodeURIComponent(best)
      .replace(/\.(html|htm|p)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  } catch {
    return '';
  }
}

function findProductNodesInJsonLd(node: unknown): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  if (!node || typeof node !== 'object') return results;

  if (Array.isArray(node)) {
    for (const item of node) {
      results.push(...findProductNodesInJsonLd(item));
    }
    return results;
  }

  const obj = node as Record<string, unknown>;
  const typeVal = obj['@type'];
  const types = Array.isArray(typeVal) ? typeVal.map(String) : typeVal ? [String(typeVal)] : [];
  if (types.some((t) => t.toLowerCase().includes('product'))) {
    results.push(obj);
  }

  if (Array.isArray(obj['@graph'])) {
    results.push(...findProductNodesInJsonLd(obj['@graph']));
  }

  if (obj.mainEntity && typeof obj.mainEntity === 'object') {
    results.push(...findProductNodesInJsonLd(obj.mainEntity));
  }

  return results;
}

export function extractCandidateUrlFromCheerio(
  el: cheerio.Cheerio<any>,
  sourceUrl: string
): string | null {
  if (!el || el.length === 0) return null;
  const target = el.is('img') ? el : el.find('img').first();
  const effective = target.length > 0 ? target : el;

  // 1. Direct src (ignore data URIs and blank spacers)
  const src = effective.attr('src');
  if (src && !src.startsWith('data:') && !src.includes('blank.gif') && !src.includes('spacer.gif')) {
    const resolved = resolveUrlMaybe(src, sourceUrl);
    if (resolved) return resolved;
  }

  // 2. High-res / lazy data attributes
  const dataAttrs = [
    effective.attr('data-old-hires'),
    effective.attr('data-hires'),
    effective.attr('data-src'),
    effective.attr('data-lazy-src'),
    effective.attr('data-zoom-src'),
    effective.attr('data-original'),
    effective.attr('data-large-img-url'),
    effective.attr('content'),
  ];
  for (const attr of dataAttrs) {
    if (attr && !attr.startsWith('data:')) {
      const resolved = resolveUrlMaybe(attr, sourceUrl);
      if (resolved) return resolved;
    }
  }

  // 3. Responsive srcset / data-srcset (take last item for highest resolution)
  const srcset = effective.attr('srcset') || effective.attr('data-srcset');
  if (srcset) {
    const candidates = srcset.split(',').map((p) => p.trim().split(/\s+/)[0]);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const item = candidates[i];
      if (item && !item.startsWith('data:')) {
        const resolved = resolveUrlMaybe(item, sourceUrl);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

export function parseProductHtml(html: string, sourceUrl: string): FetchedProductMetadata {
  const $ = cheerio.load(html);
  const store_name = detectStoreName(sourceUrl);

  let name = '';
  let price: string | null = null;
  let image_url: string | null = null;
  let color: string | null = null;
  let size: string | null = null;
  let model: string | null = null;

  // 1. JSON-LD schema.org/Product
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const products = findProductNodesInJsonLd(parsed);
      for (const prod of products) {
        if (!name && typeof prod.name === 'string') {
          name = prod.name.trim();
        }
        if (!image_url) {
          if (typeof prod.image === 'string') {
            image_url = resolveUrlMaybe(prod.image, sourceUrl);
          } else if (Array.isArray(prod.image) && prod.image.length > 0) {
            const firstImg = prod.image[0];
            if (typeof firstImg === 'string') {
              image_url = resolveUrlMaybe(firstImg, sourceUrl);
            } else if (firstImg && typeof firstImg === 'object' && 'url' in firstImg) {
              image_url = resolveUrlMaybe(String((firstImg as { url: unknown }).url), sourceUrl);
            }
          } else if (prod.image && typeof prod.image === 'object' && 'url' in prod.image) {
            image_url = resolveUrlMaybe(String((prod.image as { url: unknown }).url), sourceUrl);
          }
        }
        if (!color && typeof prod.color === 'string') color = prod.color.trim();
        if (!size && typeof prod.size === 'string') size = prod.size.trim();
        if (!model && typeof prod.model === 'string') model = prod.model.trim();
        if (!model && typeof prod.sku === 'string') model = prod.sku.trim();

        if (!price && prod.offers) {
          const offersList = Array.isArray(prod.offers) ? prod.offers : [prod.offers];
          for (const offer of offersList) {
            if (offer && typeof offer === 'object') {
              const o = offer as Record<string, unknown>;
              const candidatePrice = o.price ?? o.lowPrice ?? o.highPrice;
              const normalized = normalizePrice(candidatePrice as string | number | undefined);
              if (normalized) {
                price = normalized;
                break;
              }
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  });

  // 2. Next.js __NEXT_DATA__ (Walmart / Target / retail SPAs)
  const nextDataRaw = $('script#__NEXT_DATA__').contents().text().trim();
  if (nextDataRaw) {
    try {
      const nextData = JSON.parse(nextDataRaw);
      const wmProduct = nextData?.props?.pageProps?.initialData?.data?.product;
      if (wmProduct && typeof wmProduct === 'object') {
        if (!name && typeof wmProduct.name === 'string') name = wmProduct.name.trim();
        if (!price) {
          price = normalizePrice(wmProduct.priceInfo?.currentPrice?.price ?? wmProduct.priceInfo?.currentPrice?.priceString);
        }
        if (!image_url) {
          image_url = resolveUrlMaybe(
            wmProduct.imageInfo?.thumbnailUrl ?? wmProduct.imageInfo?.allImages?.[0]?.url,
            sourceUrl
          );
        }
        if (!model && typeof wmProduct.model === 'string') model = wmProduct.model.trim();
      }
    } catch {
      // Ignore malformed __NEXT_DATA__
    }
  }

  // 3. Amazon-specific DOM selectors
  const amzTitle = $('#productTitle, #titleSection #title').first().text().trim();
  if (!name && amzTitle) {
    name = amzTitle;
  }

  // 4. Universal E-Commerce & Microdata Title / Name
  if (!name) {
    const domTitle = $(
      'h1[itemprop="name"], [itemprop="name"], h1.product-title, h1.product__title, h1.product-name, h1.product_title, h1.pdp-title, .product-single__title, h1'
    )
      .first()
      .text()
      .trim();
    if (domTitle) name = domTitle;
  }

  // Universal Price Extraction (Amazon DOM + Microdata + Meta tags + Common E-Commerce selectors)
  if (!price) {
    const amzPriceText =
      $(
        '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, .a-price .a-offscreen'
      )
        .first()
        .text()
        .trim();
    if (amzPriceText) price = normalizePrice(amzPriceText);
  }

  if (!price) {
    const metaPrice =
      $('meta[property="product:price:amount"]').attr('content') ||
      $('meta[property="og:price:amount"]').attr('content') ||
      $('meta[property="product:sale_price:amount"]').attr('content') ||
      $('meta[itemprop="price"]').attr('content') ||
      $('meta[name="twitter:data1"]').attr('content') ||
      $('meta[name="price"]').attr('content');
    if (metaPrice) price = normalizePrice(metaPrice);
  }

  if (!price) {
    const priceSelectors = [
      '[itemprop="price"]',
      '[data-product-price]',
      '[data-price]',
      '[data-price-amount]',
      '.kib-product-price__label',
      '.kib-product-price',
      '[class*="kib-product-price"]',
      '[class*="kib-product-price__label"]',
      '[data-testid="advertised-price"]',
      '[data-testid*="price"]',
      '[class*="product-price"]',
      '[class*="ProductPrice"]',
      '[class*="price-label"]',
      '[class*="price__label"]',
      '[class*="Price__Label"]',
      '.price-item--sale',
      '.price-item--regular',
      '.price-item',
      '.woocommerce-Price-amount',
      '.product-price',
      '.product__price',
      '.price__current',
      '.current-price',
      '.sale-price',
      '.special-price',
      '.regular-price',
      '.offer-price',
      '.pdp-price',
      '.product-detail__price',
      '.price .amount',
      '.price',
    ];
    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length === 0) continue;
      const text = el.attr('content') || el.attr('data-price') || el.text().trim();
      const normalized = normalizePrice(text);
      if (normalized) {
        price = normalized;
        break;
      }
    }
  }

  // Universal Image Extraction (Amazon DOM + OpenGraph/Twitter + Microdata + Common E-Commerce selectors)
  if (!image_url) {
    const prioritySelectors = [
      '#landingImage',
      '#imgBlkFront',
      '#gc-standard-design-image',
      '#main-image',
      '#imgTagWrapperId img',
    ];
    for (const sel of prioritySelectors) {
      const landingImg = $(sel).first();
      if (landingImg.length === 0) continue;
      const oldHires = landingImg.attr('data-old-hires');
      const dynamicJson = landingImg.attr('data-a-dynamic-image');
      let dynamicUrl: string | null = null;
      if (dynamicJson) {
        try {
          const parsedMap = JSON.parse(dynamicJson) as Record<string, unknown>;
          const keys = Object.keys(parsedMap);
          if (keys.length > 0) dynamicUrl = keys[0];
        } catch {
          // ignore
        }
      }
      const candidate =
        resolveUrlMaybe(oldHires, sourceUrl) ||
        resolveUrlMaybe(dynamicUrl, sourceUrl) ||
        resolveUrlMaybe(landingImg.attr('src'), sourceUrl);
      if (candidate) {
        image_url = candidate;
        break;
      }
    }
  }

  if (!image_url) {
    const hiResMatch =
      html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/) ||
      html.match(/"large"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (hiResMatch) {
      image_url = resolveUrlMaybe(hiResMatch[1], sourceUrl);
    }
  }

  if (!image_url) {
    const metaImg =
      $('meta[property="og:image:secure_url"]').attr('content') ||
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[name="twitter:image:src"]').attr('content') ||
      $('link[rel="image_src"]').attr('href');
    if (metaImg) image_url = resolveUrlMaybe(metaImg, sourceUrl);
  }

  if (!image_url) {
    const imgSelectors = [
      '[class*="styles_mainCarouselImage"]',
      '[class*="mainCarouselImage"]',
      'img[class*="mainCarouselImage"]',
      'img[class*="styles_mainCarouselImage"]',
      '[class*="mainCarousel"] img',
      '[class*="CarouselImage"]',
      'img[class*="CarouselImage"]',
      '[data-testid*="carousel-image"]',
      '[data-testid*="product-image"] img',
      'img[data-testid*="carousel"]',
      'img[data-testid*="product"]',
      'img[data-product-image]',
      'img[itemprop="image"]',
      '[itemprop="image"]',
      '.product-single__photo img',
      '.woocommerce-product-gallery__image img',
      '.product-image img',
      '.product__image img',
      '.main-image img',
      '.featured-image img',
      'img.product-image',
      'img.product__image',
      'img.featured-image',
    ];
    for (const sel of imgSelectors) {
      const el = $(sel).first();
      if (el.length === 0) continue;
      const candidate = extractCandidateUrlFromCheerio(el, sourceUrl);
      if (candidate) {
        image_url = candidate;
        break;
      }
    }
  }

  // Universal Color / Size / Model Extraction
  if (!color) {
    const amzColor = $(
      '#variation_color_name .selection, #inline-twister-expanded-dimension-text-color_name'
    )
      .first()
      .text()
      .trim();
    if (amzColor) color = amzColor;
  }
  if (!color) {
    const metaColor =
      $('meta[property="product:color"]').attr('content') ||
      $('[itemprop="color"]').first().text().trim() ||
      $('[itemprop="color"]').attr('content');
    if (metaColor) color = metaColor.trim();
  }

  if (!size) {
    const amzSize = $(
      '#variation_size_name .selection, #inline-twister-expanded-dimension-text-size_name'
    )
      .first()
      .text()
      .trim();
    if (amzSize) size = amzSize;
  }
  if (!size) {
    const metaSize =
      $('meta[property="product:size"]').attr('content') ||
      $('[itemprop="size"]').first().text().trim() ||
      $('[itemprop="size"]').attr('content');
    if (metaSize) size = metaSize.trim();
  }

  if (!model) {
    $('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr').each((_, row) => {
      const th = $(row).find('th').text().trim().toLowerCase();
      const td = $(row).find('td').text().replace(/\u200e/g, '').trim();
      if (th.includes('model number') && td && !model) {
        model = td;
      }
    });
  }
  if (!model) {
    const metaModel =
      $('meta[property="product:retailer_item_id"]').attr('content') ||
      $('meta[property="product:mfr_part_no"]').attr('content') ||
      $('[itemprop="sku"]').attr('content') ||
      $('[itemprop="sku"]').first().text().trim() ||
      $('[itemprop="model"]').attr('content') ||
      $('[itemprop="model"]').first().text().trim();
    if (metaModel) model = metaModel.trim();
  }

  // Meta Title Fallback
  if (!name) {
    const ogTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').first().text();
    if (ogTitle) {
      name = ogTitle.trim();
    }
  }

  // Clean trailing or leading store branding from product title
  if (name) {
    name = name
      .replace(/\s*[-|:•—]\s*(Amazon\.com|Target|Walmart\.com|Best Buy|Kohl's).*$/i, '')
      .replace(/^Amazon\.com\s*:\s*/i, '');
    if (store_name) {
      const escapedStore = store_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      name = name
        .replace(new RegExp(`\\s*[-|:•—]\\s*${escapedStore}(\\.com)?.*$`, 'i'), '')
        .replace(new RegExp(`^${escapedStore}\\s*[-|:•—]\\s*`, 'i'), '');
    }
    name = name.trim();
  }

  // Detect robot/CAPTCHA block pages
  const lowerName = name.toLowerCase();
  const isBlockedTitle =
    !name ||
    lowerName === 'robot or human?' ||
    lowerName.includes('access denied') ||
    lowerName.includes('sorry! something went wrong') ||
    lowerName === 'amazon.com';

  if (isBlockedTitle) {
    name = extractSlugFallbackTitle(sourceUrl);
  }

  const partial = isBlockedTitle || !name || (!price && !image_url);

  return {
    url: sourceUrl,
    name,
    price,
    image_url,
    color,
    size,
    model,
    store_name,
    partial,
  };
}

async function fetchSafeHtml(
  initialUrl: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  checkLiveDns: boolean
): Promise<{ ok: boolean; html: string; finalUrl: string }> {
  let currentUrl = initialUrl;
  let response: Response | null = null;

  for (let hop = 0; hop < 5; hop++) {
    const parsedHop = validateSafeExternalUrl(currentUrl);
    if (checkLiveDns) {
      await assertSafeResolvedHostname(parsedHop.hostname);
    }

    response = await fetchImpl(currentUrl, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      const resolvedRedirect = new URL(location, currentUrl).toString();
      currentUrl = validateSafeExternalUrl(resolvedRedirect).toString();
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    return { ok: false, html: '', finalUrl: currentUrl };
  }
  const bytes = await readResponseBytesWithLimit(response, MAX_HTML_BYTES);
  if (!bytes) {
    return { ok: false, html: '', finalUrl: currentUrl };
  }
  return { ok: true, html: new TextDecoder().decode(bytes), finalUrl: currentUrl };
}

export async function fetchProductMetadata(
  url: string,
  options?: { fetchFn?: typeof fetch }
): Promise<FetchedProductMetadata> {
  const safeUrl = validateSafeExternalUrl(url);
  const normalizedUrl = safeUrl.toString();
  const targetFetchUrl = canonicalizeFetchUrl(safeUrl);
  const store_name = detectStoreName(normalizedUrl);
  const fetchImpl = options?.fetchFn || fetch;
  const checkLiveDns = !options?.fetchFn;

  try {
    const primaryHeaders: Record<string, string> =
      store_name === 'Walmart'
        ? {
            'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        : {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
          };

    const primary = await fetchSafeHtml(targetFetchUrl, fetchImpl, primaryHeaders, checkLiveDns);

    let result: FetchedProductMetadata = primary.ok
      ? { ...parseProductHtml(primary.html, normalizedUrl), url: normalizedUrl }
      : {
          url: normalizedUrl,
          name: extractSlugFallbackTitle(normalizedUrl),
          price: null,
          image_url: null,
          color: null,
          size: null,
          model: null,
          store_name,
          partial: true,
        };

    // Universal Fallback: If primary fetch was blocked/CAPTCHA'd or returned missing image/title/price on ANY site,
    // fetch with social link preview crawler (which e-commerce sites rarely block to allow previews in Messenger/WhatsApp/etc.)
    if ((!primary.ok || result.partial || !result.image_url || !result.price) && !options?.fetchFn) {
      const fallback = await fetchSafeHtml(
        targetFetchUrl,
        fetchImpl,
        {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        checkLiveDns
      );
      if (fallback.ok) {
        const fbMeta = parseProductHtml(fallback.html, normalizedUrl);
        result = {
          url: normalizedUrl,
          name: (!result.partial && result.name) || fbMeta.name || result.name,
          price: result.price || fbMeta.price,
          image_url: result.image_url || fbMeta.image_url,
          color: result.color || fbMeta.color,
          size: result.size || fbMeta.size,
          model: result.model || fbMeta.model,
          store_name: result.store_name || fbMeta.store_name,
          partial: !(result.name || fbMeta.name) || !(result.price || fbMeta.price || result.image_url || fbMeta.image_url),
        };
      }
    }

    // ISBN/EAN book cover fallback (e.g. Barnes & Noble ?ean=978...)
    if (!result.image_url) {
      const eanMatch =
        safeUrl.searchParams.get('ean')?.match(/^(97[89]\d{10})$/) ||
        normalizedUrl.match(/\b(97[89]\d{10})\b/);
      if (eanMatch) {
        result.image_url = `https://covers.openlibrary.org/b/isbn/${eanMatch[1]}-L.jpg?default=false`;
      }
    }

    return result;
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw err;
    }
    const eanMatch =
      safeUrl.searchParams.get('ean')?.match(/^(97[89]\d{10})$/) ||
      normalizedUrl.match(/\b(97[89]\d{10})\b/);
    return {
      url: normalizedUrl,
      name: extractSlugFallbackTitle(normalizedUrl),
      price: null,
      image_url: eanMatch ? `https://covers.openlibrary.org/b/isbn/${eanMatch[1]}-L.jpg?default=false` : null,
      color: null,
      size: null,
      model: null,
      store_name,
      partial: true,
    };
  }
}

function sniffRasterImageMime(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 4) return null;
  // Reject anything starting with whitespace + '<' (SVG / HTML / XML)
  for (let i = 0; i < Math.min(bytes.byteLength, 32); i++) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b === 0x3c) return null; // '<'
    break;
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: RIFF....WEBP
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export async function downloadImageBlob(
  imageUrl: string,
  options?: { fetchFn?: typeof fetch }
): Promise<{ blob: Uint8Array; mimeType: string } | null> {
  const safeUrl = validateSafeExternalUrl(imageUrl);
  const fetchImpl = options?.fetchFn || fetch;
  const checkLiveDns = !options?.fetchFn;

  try {
    let currentUrl = safeUrl.toString();
    let response: Response | null = null;

    for (let hop = 0; hop < 5; hop++) {
      const parsedHop = validateSafeExternalUrl(currentUrl);
      if (checkLiveDns) {
        await assertSafeResolvedHostname(parsedHop.hostname);
      }

      response = await fetchImpl(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
          Accept: 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.5',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        const resolvedRedirect = new URL(location, currentUrl).toString();
        currentUrl = validateSafeExternalUrl(resolvedRedirect).toString();
        continue;
      }
      break;
    }

    if (!response || !response.ok) return null;

    let rawCt = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (rawCt === 'image/jpg') rawCt = 'image/jpeg';

    // Explicitly block SVG and non-raster types
    if (
      rawCt &&
      !ALLOWED_RASTER_IMAGE_MIMES.has(rawCt) &&
      rawCt !== 'application/octet-stream'
    ) {
      return null;
    }

    const bytes = await readResponseBytesWithLimit(response, MAX_IMAGE_BYTES);
    if (!bytes || bytes.byteLength === 0) {
      return null;
    }

    // Reject any XML/HTML/SVG payload disguised with a raster or octet-stream Content-Type
    const sniffed = sniffRasterImageMime(bytes);
    if (rawCt === 'application/octet-stream' || !rawCt) {
      if (!sniffed) return null;
      return { blob: bytes, mimeType: sniffed };
    }

    // Even when Content-Type is in ALLOWED_RASTER_IMAGE_MIMES, block buffers starting with '<'
    for (let i = 0; i < Math.min(bytes.byteLength, 32); i++) {
      const b = bytes[i];
      if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
      if (b === 0x3c) return null;
      break;
    }

    return {
      blob: bytes,
      mimeType: rawCt,
    };
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw err;
    }
    return null;
  }
}
