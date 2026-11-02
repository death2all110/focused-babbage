import { describe, it, expect } from 'vitest';
import {
  parseProductHtml,
  validateSafeExternalUrl,
  normalizePrice,
  fetchProductMetadata,
  downloadImageBlob,
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

  it('extracts Amazon gift card and script-embedded hiRes product images', () => {
    const giftCardHtml = `
      <html>
        <body>
          <span id="productTitle">Amazon.com Gift Card in a Mini Envelope</span>
          <div id="imgTagWrapperId">
            <img id="gc-standard-design-image" src="https://m.media-amazon.com/images/I/gc-envelope.jpg" />
          </div>
        </body>
      </html>
    `;
    const gcMeta = parseProductHtml(giftCardHtml, 'https://www.amazon.com/dp/B06WVJBLBQ/');
    expect(gcMeta.image_url).toBe('https://m.media-amazon.com/images/I/gc-envelope.jpg');

    const scriptImgHtml = `
      <html>
        <body>
          <span id="productTitle">Govee Ambilight TV Kit</span>
          <script>
            var data = { 'colorImages': { 'initial': [{"hiRes":"https://m.media-amazon.com/images/I/71govee-hires._AC_SL1500_.jpg","large":"https://m.media-amazon.com/images/I/51govee.jpg"}] } };
          </script>
        </body>
      </html>
    `;
    const scriptMeta = parseProductHtml(scriptImgHtml, 'https://www.amazon.com/dp/B0CHS2BGHY');
    expect(scriptMeta.image_url).toBe('https://m.media-amazon.com/images/I/71govee-hires._AC_SL1500_.jpg');
  });

  it('ignores header Prime logos (/images/G/), canonicalizes dirty Amazon /ref= URLs when fetching, and never uses ref= as a fallback title', async () => {
    const htmlWithPrimeBanner = `
      <html>
        <body>
          <header>
            <img class="a-dynamic-image" src="https://m.media-amazon.com/images/G/01/marketing/prime/2022PrimeBrand/Logos/Prime_Logo_RGB_Prime_Blue_MASTER._CB542735979_.png" />
          </header>
          <span id="productTitle">Goupchn 5PCS 4mm Stackable Banana to Banana Plug Test Leads</span>
          <div id="corePriceDisplay_desktop_feature_div">
            <span class="a-price"><span class="a-offscreen">$12.99</span></span>
          </div>
          <div id="imgTagWrapperId">
            <img id="landingImage" class="a-dynamic-image" data-old-hires="https://m.media-amazon.com/images/I/71xbpzSNPIL._AC_SL1500_.jpg" src="https://m.media-amazon.com/images/I/71xbpzSNPIL._AC_SX522_.jpg" />
          </div>
        </body>
      </html>
    `;

    const fetchedUrls: string[] = [];
    const dirtyUrl = 'https://www.amazon.com/dp/B083K8LRM6/ref=sspa_dk_detail_4?psc=1';
    const meta = await fetchProductMetadata(dirtyUrl, {
      fetchFn: async (input) => {
        fetchedUrls.push(String(input));
        return new Response(htmlWithPrimeBanner, { status: 200 });
      },
    });

    expect(fetchedUrls[0]).toBe('https://www.amazon.com/dp/B083K8LRM6');
    expect(meta.url).toBe(dirtyUrl);
    expect(meta.name).toBe('Goupchn 5PCS 4mm Stackable Banana to Banana Plug Test Leads');
    expect(meta.price).toBe('$12.99');
    expect(meta.image_url).toBe('https://m.media-amazon.com/images/I/71xbpzSNPIL._AC_SL1500_.jpg');

    const blockedMeta = parseProductHtml(
      '<html><head><title>Amazon.com</title></head><body>Robot Check</body></html>',
      dirtyUrl
    );
    expect(blockedMeta.name).not.toMatch(/ref=/i);
  });

  it('uses Googlebot UA for Walmart, falls back to OpenLibrary ISBN cover for Barnes & Noble EANs, and downloads image BLOBs safely', async () => {
    const usedUserAgents: string[] = [];
    const wmNextData = {
      props: {
        pageProps: {
          initialData: {
            data: {
              product: {
                name: 'Nee Doh Candy Swirl, 1pc',
                priceInfo: { currentPrice: { price: 29.95 } },
                imageInfo: { thumbnailUrl: 'https://i5.walmartimages.com/seo/Nee-Doh.png' },
                model: '20560108950',
              },
            },
          },
        },
      },
    };
    const wmMeta = await fetchProductMetadata('https://www.walmart.com/ip/Nee-Doh-Candy-Swirl-1pc/20560108950', {
      fetchFn: async (_input, init) => {
        const ua = (init?.headers as Record<string, string>)?.['User-Agent'] || '';
        usedUserAgents.push(ua);
        return new Response(
          `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(wmNextData)}</script></head></html>`,
          { status: 200 }
        );
      },
    });
    expect(usedUserAgents[0]).toMatch(/Googlebot/i);
    expect(wmMeta.name).toBe('Nee Doh Candy Swirl, 1pc');
    expect(wmMeta.price).toBe('$29.95');
    expect(wmMeta.image_url).toBe('https://i5.walmartimages.com/seo/Nee-Doh.png');

    // Barnes & Noble with ?ean=9781449476281 gets OpenLibrary ISBN cover fallback if blocked
    const bnMeta = await fetchProductMetadata(
      'https://www.barnesandnoble.com/w/unicorn-vs-goblins-dana-simpson/1123179889?ean=9781449476281',
      {
        fetchFn: async () => new Response('Access Denied', { status: 403 }),
      }
    );
    expect(bnMeta.image_url).toBe('https://covers.openlibrary.org/b/isbn/9781449476281-L.jpg?default=false');

    // downloadImageBlob fetches bytes + mimeType and rejects SSRF
    const fakeJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const downloaded = await downloadImageBlob('https://i5.walmartimages.com/seo/Nee-Doh.png', {
      fetchFn: async () =>
        new Response(fakeJpg, {
          status: 200,
          headers: { 'content-type': 'image/png; charset=binary' },
        }),
    });
    expect(downloaded).not.toBeNull();
    expect(downloaded!.mimeType).toBe('image/png');
    expect(Array.from(downloaded!.blob)).toEqual([0xff, 0xd8, 0xff, 0xd9]);

    await expect(downloadImageBlob('http://127.0.0.1:8080/secret.jpg')).rejects.toThrow();
  });

  it('scrapes generic e-commerce sites (Shopify, WooCommerce, custom boutiques) with standard DOM selectors and microdata', () => {
    const shopifyHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Handcrafted Leather Boots - Artisan Leatherworks</title>
          <meta property="og:title" content="Handcrafted Leather Boots - Artisan Leatherworks" />
          <meta property="og:image" content="https://cdn.shopify.com/s/files/boots.jpg" />
          <meta property="product:price:amount" content="249.00" />
          <meta property="product:price:currency" content="USD" />
          <meta property="product:color" content="Cognac Brown" />
          <meta property="product:size" content="10.5 US" />
        </head>
        <body>
          <h1 class="product-title">Handcrafted Leather Boots</h1>
          <span class="price-item--sale">$249.00</span>
          <img class="product-featured-image" src="https://cdn.shopify.com/s/files/boots.jpg" />
        </body>
      </html>
    `;

    const meta = parseProductHtml(shopifyHtml, 'https://artisan-leatherworks.com/products/boots');
    expect(meta.name).toBe('Handcrafted Leather Boots');
    expect(meta.price).toBe('$249.00');
    expect(meta.image_url).toBe('https://cdn.shopify.com/s/files/boots.jpg');
    expect(meta.color).toBe('Cognac Brown');
    expect(meta.size).toBe('10.5 US');
    expect(meta.store_name).toBe('Artisan Leatherworks');
    expect(meta.partial).toBe(false);
  });

  it('scrapes WooCommerce and microdata product pages and extracts foreign currency symbols', () => {
    const wooHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Ceramic Coffee Mug | Nordic Pottery</title>
        </head>
        <body>
          <h1 itemprop="name" class="product_title">Ceramic Coffee Mug</h1>
          <p class="price"><span class="woocommerce-Price-amount amount">&pound;18.50</span></p>
          <div class="woocommerce-product-gallery__image">
            <img src="/wp-content/uploads/mug.jpg" />
          </div>
          <span itemprop="color">Speckled White</span>
          <span itemprop="sku">MUG-WHT-01</span>
        </body>
      </html>
    `;

    const meta = parseProductHtml(wooHtml, 'https://nordic-pottery.co.uk/shop/mug');
    expect(meta.name).toBe('Ceramic Coffee Mug');
    expect(meta.price).toBe('£18.50');
    expect(meta.image_url).toBe('https://nordic-pottery.co.uk/wp-content/uploads/mug.jpg');
    expect(meta.color).toBe('Speckled White');
    expect(meta.model).toBe('MUG-WHT-01');
    expect(meta.store_name).toBe('Nordic Pottery');
    expect(meta.partial).toBe(false);
  });

  it('scrapes Chewy product pages using KIB price components and hashed CSS-modules carousel images', () => {
    const chewyHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Frisco Heavy Duty Steel Cat & Dog Gate, 36-in - Chewy.com</title>
        </head>
        <body>
          <h1 class="kib-product-title">Frisco Heavy Duty Steel Cat & Dog Gate, 36-in</h1>
          <div class="kib-product-price">
            <span class="kib-product-price__label">$49.99</span>
          </div>
          <div class="styles_carouselWrapper__abc12">
            <img
              class="styles_mainCarouselImage__kiYyf"
              src="https://image.chewy.com/is/image/catalog/12345_MAIN._AC_SL600_V1564757530_.jpg"
              alt="Frisco Gate"
            />
          </div>
          <span itemprop="color">White</span>
          <span itemprop="size">36-in</span>
        </body>
      </html>
    `;

    const meta = parseProductHtml(chewyHtml, 'https://www.chewy.com/dp/12345');
    expect(meta.name).toBe('Frisco Heavy Duty Steel Cat & Dog Gate, 36-in');
    expect(meta.price).toBe('$49.99');
    expect(meta.image_url).toBe('https://image.chewy.com/is/image/catalog/12345_MAIN._AC_SL600_V1564757530_.jpg');
    expect(meta.color).toBe('White');
    expect(meta.size).toBe('36-in');
    expect(meta.store_name).toBe('Chewy');
    expect(meta.partial).toBe(false);
  });
});
