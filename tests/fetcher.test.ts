import { describe, it, expect } from 'vitest';
import {
  parseProductHtml,
  validateSafeExternalUrl,
  normalizePrice,
  fetchProductMetadata,
} from '../src/server/fetcher';

describe('Product URL Fetcher', () => {
  it('extracts Amazon title, price, image, color, size, and model from Amazon DOM', () => {
    const html = `
      <html>
        <body>
          <span id="productTitle">  Hurley Men's 5-Pack Stretch Boxer Briefs  </span>
          <div id="corePriceDisplay_desktop_feature_div">
            <span class="a-price"><span class="a-offscreen">$19.74</span></span>
          </div>
          <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/71hurley.jpg" src="https://m.media-amazon.com/images/I/thumb.jpg" />
          <div id="variation_color_name"><span class="selection">Blue Flamingo Combo</span></div>
          <div id="variation_size_name"><span class="selection">Medium</span></div>
          <table id="productDetails_techSpec_section_1">
            <tr><th>Item model number</th><td>HRL-5PK-M</td></tr>
          </table>
        </body>
      </html>
    `;
    const meta = parseProductHtml(html, 'https://www.amazon.com/dp/B0FW1J41WF');
    expect(meta.name).toBe("Hurley Men's 5-Pack Stretch Boxer Briefs");
    expect(meta.price).toBe('$19.74');
    expect(meta.image_url).toBe('https://m.media-amazon.com/images/I/71hurley.jpg');
    expect(meta.color).toBe('Blue Flamingo Combo');
    expect(meta.size).toBe('Medium');
    expect(meta.model).toBe('HRL-5PK-M');
    expect(meta.store_name).toBe('Amazon');
    expect(meta.partial).toBe(false);
  });

  it('extracts schema.org/Product JSON-LD (Target, Best Buy, Kohls) and resolves relative image URLs and bare prices', () => {
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Product",
                  "name": "KitchenAid Artisan 5-Qt Stand Mixer",
                  "image": ["/images/mixer-pistachio.jpg"],
                  "color": "Pistachio",
                  "size": "5 Quart",
                  "model": "KSM150PS",
                  "offers": {
                    "@type": "Offer",
                    "price": 349.99,
                    "priceCurrency": "USD"
                  }
                }
              ]
            }
          </script>
        </head>
      </html>
    `;
    const meta = parseProductHtml(html, 'https://www.target.com/p/kitchenaid/-/A-12345');
    expect(meta.name).toBe('KitchenAid Artisan 5-Qt Stand Mixer');
    expect(meta.price).toBe('$349.99');
    expect(meta.image_url).toBe('https://www.target.com/images/mixer-pistachio.jpg');
    expect(meta.color).toBe('Pistachio');
    expect(meta.size).toBe('5 Quart');
    expect(meta.model).toBe('KSM150PS');
    expect(meta.store_name).toBe('Target');
  });

  it('extracts Walmart __NEXT_DATA__ initialData.data.product payload', () => {
    const nextData = {
      props: {
        pageProps: {
          initialData: {
            data: {
              product: {
                name: 'LEGO Star Wars Millennium Falcon',
                priceInfo: { currentPrice: { price: 169.99 } },
                imageInfo: { thumbnailUrl: 'https://i5.walmartimages.com/falcon.jpg' },
                model: '75257',
              },
            },
          },
        },
      },
    };
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></head></html>`;
    const meta = parseProductHtml(html, 'https://www.walmart.com/ip/12345');
    expect(meta.name).toBe('LEGO Star Wars Millennium Falcon');
    expect(meta.price).toBe('$169.99');
    expect(meta.image_url).toBe('https://i5.walmartimages.com/falcon.jpg');
    expect(meta.model).toBe('75257');
    expect(meta.store_name).toBe('Walmart');
  });

  it('rejects private/loopback SSRF URLs and normalizes prices', () => {
    expect(() => validateSafeExternalUrl('http://127.0.0.1:8080/admin')).toThrow();
    expect(() => validateSafeExternalUrl('http://192.168.1.1/router')).toThrow();
    expect(() => validateSafeExternalUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => validateSafeExternalUrl('file:///etc/passwd')).toThrow();
    expect(normalizePrice('47.48')).toBe('$47.48');
    expect(normalizePrice('$139.99')).toBe('$139.99');
  });

  it('returns graceful partial metadata when a store blocks scraping or returns 403', async () => {
    const result = await fetchProductMetadata('https://www.bestbuy.com/site/sony-tv/654321.p', {
      fetchFn: async () => new Response('Access Denied', { status: 403 }),
    });
    expect(result.url).toBe('https://www.bestbuy.com/site/sony-tv/654321.p');
    expect(result.partial).toBe(true);
    expect(result.store_name).toBe('Best Buy');
  });

  it('rejects IPv4-mapped IPv6 addresses and unsafe HTTP redirects', async () => {
    expect(() => validateSafeExternalUrl('http://[::ffff:127.0.0.1]/admin')).toThrow();
    expect(() => validateSafeExternalUrl('http://[::ffff:192.168.1.1]/router')).toThrow();
    expect(() => validateSafeExternalUrl('http://[::]/')).toThrow();

    await expect(
      fetchProductMetadata('https://short.example.com/deal', {
        fetchFn: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1:8080/internal' },
          }),
      })
    ).rejects.toThrow(/Private or loopback|Localhost|not allowed/i);
  });
});
