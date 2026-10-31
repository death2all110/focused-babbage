import * as cheerio from 'cheerio';
import net from 'node:net';
import type { FetchedProductMetadata } from '../shared/types.js';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip === '0.0.0.0' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

export function validateSafeExternalUrl(rawUrl: string): URL {
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
    host.endsWith('.internal')
  ) {
    throw new UnsafeUrlError('Localhost and internal hostnames are not allowed.');
  }

  if (net.isIP(host) && isPrivateIp(host)) {
    throw new UnsafeUrlError('Private or loopback IP addresses are not allowed.');
  }

  return parsed;
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
    if (host.includes('etsy.com')) return 'Etsy';
    const parts = host.replace(/^www\./, '').split('.');
    if (parts.length >= 2) {
      const domain = parts[0];
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

function resolveUrlMaybe(candidate: string | null | undefined, baseUrl: string): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
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

  return results;
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

  if (!price) {
    const amzPriceText =
      $(
        '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, .a-price .a-offscreen'
      )
        .first()
        .text()
        .trim() || $('meta[property="product:price:amount"], meta[name="twitter:data1"]').attr('content');
    price = normalizePrice(amzPriceText);
  }

  if (!image_url) {
    const landingImg = $('#landingImage, #imgBlkFront').first();
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
    image_url =
      resolveUrlMaybe(oldHires, sourceUrl) ||
      resolveUrlMaybe(dynamicUrl, sourceUrl) ||
      resolveUrlMaybe(landingImg.attr('src'), sourceUrl);
  }

  if (!color) {
    const amzColor = $(
      '#variation_color_name .selection, #inline-twister-expanded-dimension-text-color_name'
    )
      .first()
      .text()
      .trim();
    if (amzColor) color = amzColor;
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

  if (!model) {
    $('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr').each((_, row) => {
      const th = $(row).find('th').text().trim().toLowerCase();
      const td = $(row).find('td').text().replace(/\u200e/g, '').trim();
      if (th.includes('model number') && td && !model) {
        model = td;
      }
    });
  }

  // 4. OpenGraph / Meta Fallbacks
  if (!name) {
    const ogTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').first().text();
    if (ogTitle) {
      name = ogTitle
        .replace(/\s*[-|:]\s*(Amazon\.com|Target|Walmart\.com|Best Buy|Kohl's).*$/i, '')
        .replace(/^Amazon\.com\s*:\s*/i, '')
        .trim();
    }
  }

  if (!image_url) {
    const ogImg =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content');
    image_url = resolveUrlMaybe(ogImg, sourceUrl);
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

export async function fetchProductMetadata(
  url: string,
  options?: { fetchFn?: typeof fetch }
): Promise<FetchedProductMetadata> {
  const safeUrl = validateSafeExternalUrl(url);
  const normalizedUrl = safeUrl.toString();
  const store_name = detectStoreName(normalizedUrl);
  const fetchImpl = options?.fetchFn || fetch;

  try {
    const response = await fetchImpl(normalizedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
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
    }

    const html = await response.text();
    return parseProductHtml(html, normalizedUrl);
  } catch {
    return {
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
  }
}
