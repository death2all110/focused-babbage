import { describe, it, expect } from 'vitest';
import {
  parseProductHtml,
  validateSafeExternalUrl,
  normalizePrice,
  fetchProductMetadata,
  downloadImageBlob,
  fetchViaBrowserless,
  fetchViaTtgmGrab,
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

  it('resolves Chewy product image and slug title via Chewy CDN fallback when HTML fetch is blocked by bot challenge (429)', async () => {
    const mockFetch = (async () => {
      return new Response(
        '<!DOCTYPE html><html><head></head><body><script>window.KPSDK={};</script></body></html>',
        {
          status: 429,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-kpsdk-ct': 'mock-kasada-token',
          },
        }
      );
    }) as unknown as typeof fetch;

    const meta = await fetchProductMetadata(
      'https://www.chewy.com/bark-animal-squeakers-snacks-multi/dp/1382534',
      { fetchFn: mockFetch }
    );

    expect(meta.name).toBe('Bark Animal Squeakers Snacks Multi');
    expect(meta.image_url).toBe('https://image.chewy.com/is/image/catalog/1382534_MAIN._AC_SL600_V1_.jpg');
    expect(meta.store_name).toBe('Chewy');
  });

  it('detects Chewy Akamai 403 WAF error pages and recovers slug title and CDN image', async () => {
    const mockFetch = (async () => {
      const akamaiWafHtml = `
        <html lang="en-US">
          <head>
            <title>403 error - No treats beyond this point - Chewy</title>
            <meta name="robots" content="noindex,nofollow">
          </head>
          <body>
            <h1 class="sfw-header__logo"><a href="/">Chewy</a></h1>
            <p>Access Denied - What happened? Chewy uses security services to protect its site.</p>
            <img src="/app/images/sfw-403-dog.png" alt="Sad puppy" />
          </body>
        </html>
      `;
      return new Response(akamaiWafHtml, {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof fetch;

    const meta = await fetchProductMetadata(
      'https://www.chewy.com/bark-animal-squeakers-snacks-multi/dp/1382534',
      { fetchFn: mockFetch }
    );

    expect(meta.name).toBe('Bark Animal Squeakers Snacks Multi');
    expect(meta.price).toBeNull();
    expect(meta.image_url).toBe('https://image.chewy.com/is/image/catalog/1382534_MAIN._AC_SL600_V1_.jpg');
    expect(meta.store_name).toBe('Chewy');
    expect(meta.partial).toBe(true);
  });

  it('detects Harbor Freight PerimeterX CAPTCHA block and recovers slug title and CDN image', async () => {
    const mockFetch = (async () => {
      const pxCaptchaHtml = `
        <!DOCTYPE html><html lang="en"><head>
          <meta name="description" content="px-captcha">
          <title>Access to this page has been denied</title>
          <script src="/j4y0BbmN/captcha/captcha.js?a=c"></script>
        </head>
        <body>
          <script>/* PerimeterX assignments */ window._pxAppId = 'PXj4y0BbmN';</script>
          <div class="px-captcha-header">Before we continue...</div>
          <div class="px-captcha-message">Press & Hold to confirm you are a human</div>
        </body></html>
      `;
      return new Response(pxCaptchaHtml, {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }) as unknown as typeof fetch;

    const meta = await fetchProductMetadata(
      'https://www.harborfreight.com/3500-lb-a-frame-weather-resistant-electric-trailer-jack-with-drop-leg-58203.html',
      { fetchFn: mockFetch }
    );

    expect(meta.name).toBe('3500 Lb A Frame Weather Resistant Electric Trailer Jack With Drop Leg 58203');
    expect(meta.price).toBeNull();
    expect(meta.image_url).toBe('https://www.harborfreight.com/media/catalog/product/cache/87bb6fe55719635edbf9f739e6fd104e/5/8/58203_W3.jpg');
    expect(meta.store_name).toBe('Harbor Freight');
    expect(meta.partial).toBe(true);
  });

  it('uses Browserless container to render full HTML including price and images when configured', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('chewy.com')) {
        // Direct request is blocked by Kasada 429
        return new Response('Blocked', { status: 429, headers: { 'x-kpsdk-ct': 'token' } });
      }
      if (urlStr.includes('/content')) {
        // Browserless renders the full client-side HTML
        const renderedHtml = `
          <!DOCTYPE html>
          <html>
            <body>
              <h1 class="kib-product-title">BARK Animal Squeakers Snacks Multi-Part Squeaky Plush Dog Toy</h1>
              <div class="kib-product-price">
                <span class="kib-product-price__label">$10.99</span>
              </div>
              <img class="styles_mainCarouselImage__kiYyf" src="https://image.chewy.com/is/image/catalog/1382534_MAIN._AC_SL600_V1_.jpg" />
            </body>
          </html>
        `;
        return new Response(renderedHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const meta = await fetchProductMetadata(
      'https://www.chewy.com/bark-animal-squeakers-snacks-multi/dp/1382534',
      {
        fetchFn: mockFetch,
        browserlessUrl: 'http://192.168.1.100:3000',
        browserlessToken: 'test-token',
      }
    );

    expect(meta.name).toBe('BARK Animal Squeakers Snacks Multi-Part Squeaky Plush Dog Toy');
    expect(meta.price).toBe('$10.99');
    expect(meta.image_url).toBe('https://image.chewy.com/is/image/catalog/1382534_MAIN._AC_SL600_V1_.jpg');
    expect(meta.partial).toBe(false);
  });

  it('triggers Browserless as universal fallback for ANY arbitrary website when blocked by Cloudflare/PerimeterX or 429', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('arbitrary-boutique.com')) {
        // Direct request returns Cloudflare challenge or 429
        return new Response('<html><title>Just a moment...</title><body>Cloudflare Challenge</body></html>', {
          status: 403,
          headers: { 'cf-mitigated': 'challenge' },
        });
      }
      if (urlStr.includes('/content')) {
        // Browserless solves the challenge and renders the boutique's product page
        const renderedHtml = `
          <!DOCTYPE html>
          <html>
            <body>
              <h1 class="product-title">Handmade Ceramic Vase</h1>
              <span class="product-price">$68.00</span>
              <img class="product-image" src="https://arbitrary-boutique.com/img/vase.jpg" />
            </body>
          </html>
        `;
        return new Response(renderedHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const meta = await fetchProductMetadata(
      'https://arbitrary-boutique.com/products/ceramic-vase',
      {
        fetchFn: mockFetch,
        browserlessUrl: 'http://192.168.1.100:3000',
      }
    );

    expect(meta.name).toBe('Handmade Ceramic Vase');
    expect(meta.price).toBe('$68.00');
    expect(meta.image_url).toBe('https://arbitrary-boutique.com/img/vase.jpg');
    expect(meta.store_name).toBe('Arbitrary Boutique');
    expect(meta.partial).toBe(false);
  });

  it('sends compliant Browserless payload without waitFor and retries on 400 schema error', async () => {
    const receivedUrls: string[] = [];
    const receivedBodies: any[] = [];
    let callCount = 0;

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      receivedUrls.push(String(input));
      if (init?.body) {
        receivedBodies.push(JSON.parse(String(init.body)));
      }
      if (callCount === 1) {
        // First call simulates a strict container rejecting extra options
        return new Response('"gotoOptions" is not allowed', { status: 400 });
      }
      // Second call with minimal payload succeeds
      return new Response('<html><body><h1>Retried Content</h1></body></html>', { status: 200 });
    }) as unknown as typeof fetch;

    const html = await fetchViaBrowserless(
      'https://example.com/item',
      'https://browserless.example.com',
      'my-token',
      mockFetch
    );

    expect(html).toContain('Retried Content');
    expect(receivedBodies.length).toBe(2);
    // Verified: stealth=true was included in initial request URL
    expect(receivedUrls[0]).toContain('stealth=true');
    // Verified: no 'waitFor' was ever sent
    expect(receivedBodies[0].waitFor).toBeUndefined();
    expect(receivedBodies[0].url).toBe('https://example.com/item');
    expect(receivedBodies[0].waitForSelector).toEqual({
      selector: expect.any(String),
      timeout: expect.any(Number),
    });
    expect(receivedBodies[0].gotoOptions?.waitUntil).toBe('networkidle2');
    // Second attempt stripped options down to pure url while keeping stealth
    expect(receivedUrls[1]).toContain('stealth=true');
    expect(receivedBodies[1]).toEqual({ url: 'https://example.com/item' });
  });

  it('extracts price from embedded state script tags (Redux/Apollo/Chewy JSON)', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Dog Toy</title></head>
        <body>
          <script type="application/json" id="__PRELOADED_STATE__">
            {"catalog":{"product":{"id":"1382534","advertisedPrice":10.99,"inStock":true}}}
          </script>
        </body>
      </html>
    `;
    const meta = parseProductHtml(html, 'https://www.chewy.com/item/1382534');
    expect(meta.price).toBe('$10.99');
  });

  it('escalates to Browserless /function when /content returns a Kasada PoW challenge shell', async () => {
    const requestedEndpoints: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      requestedEndpoints.push(urlStr);
      if (urlStr.includes('/content')) {
        // First returns the 911-byte Kasada challenge
        const kasadaHtml = `<!DOCTYPE html><html><body><script>window.KPSDK={};</script><script src="/ips.js"></script></body></html>`;
        return new Response(kasadaHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (urlStr.includes('/function')) {
        // Function waits and returns resolved HTML
        const solvedHtml = `<!DOCTYPE html><html><body><h1>Chewy Dog Toy</h1><span class="kib-product-price">$12.49</span></body></html>`;
        return new Response(solvedHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const html = await fetchViaBrowserless(
      'https://www.chewy.com/dp/123',
      'https://browserless.darkxshadows.net',
      'token123',
      mockFetch
    );

    expect(html).toContain('Chewy Dog Toy');
    expect(html).toContain('$12.49');
    expect(requestedEndpoints.some((u) => u.includes('/content'))).toBe(true);
    expect(requestedEndpoints.some((u) => u.includes('/function'))).toBe(true);
  });

  it('uses custom USER_AGENT environment variable when provided', async () => {
    process.env.USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0';
    try {
      let sentHeaders: Record<string, string> = {};
      const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        sentHeaders = (init?.headers as Record<string, string>) || {};
        return new Response(
          '<html><head><title>Test Item</title></head><body><h1>Test Item</h1><span class="price">$19.99</span></body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }
        );
      }) as unknown as typeof fetch;

      await fetchProductMetadata('https://example.com/product/123', { fetchFn: mockFetch });
      expect(sentHeaders['User-Agent']).toBe('Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0');
    } finally {
      delete process.env.USER_AGENT;
    }
  });

  it('gracefully handles HTTP 429 from Browserless by backing off and returning null', async () => {
    const mockFetch = (async () => {
      return new Response('Too Many Requests', { status: 429 });
    }) as unknown as typeof fetch;

    const res = await fetchViaBrowserless(
      'https://example.com/busy-item',
      'https://browserless.example.com',
      'token',
      mockFetch
    );
    expect(res).toBeNull();
  });

  it('queries TTGM grab.json with origin, referer, and context headers and returns parsed metadata', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      capturedUrl = urlStr;
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      if (init?.body) {
        capturedBody = JSON.parse(String(init.body));
      }
      return new Response(
        JSON.stringify({
          success: 'OK',
          name: 'Frisco Heavy Duty Cat & Dog Gate',
          price: '$49.99',
          images: ['https://image.chewy.com/catalog/gate.jpg'],
          url: 'https://www.chewy.com/dp/12345',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    }) as unknown as typeof fetch;

    const meta = await fetchViaTtgmGrab('https://www.chewy.com/dp/12345', mockFetch);
    expect(capturedUrl).toBe('https://www.thingstogetme.com/api/app/grab.json');
    expect(capturedHeaders['Origin']).toBe('https://www.thingstogetme.com');
    expect(capturedHeaders['Referer']).toBe('https://www.thingstogetme.com/');
    expect(capturedHeaders['Content-Type']).toBe('application/json');
    expect(capturedBody).toEqual({
      url: 'https://www.chewy.com/dp/12345',
      _context: 'web',
    });
    expect(meta).toEqual({
      name: 'Frisco Heavy Duty Cat & Dog Gate',
      price: '$49.99',
      image_url: 'https://image.chewy.com/catalog/gate.jpg',
      store_name: 'Chewy',
    });
  });

  it('handles TTGM grab API failures and non-OK responses gracefully', async () => {
    const errorFetch = (async () => {
      return new Response(JSON.stringify({ error: 'Not allowed' }), { status: 403 });
    }) as unknown as typeof fetch;

    const res = await fetchViaTtgmGrab('https://www.chewy.com/dp/12345', errorFetch);
    expect(res).toBeNull();
  });

  it('uses TTGM grab as fast intermediate fallback when primary scrape is blocked', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('chewy.com')) {
        // Direct request is blocked by Kasada 429
        return new Response('Blocked by Kasada', { status: 429 });
      }
      if (urlStr.includes('thingstogetme.com/api/app/grab.json')) {
        // TTGM Grab succeeds
        return new Response(
          JSON.stringify({
            success: 'OK',
            name: 'BARK Animal Squeakers Dog Toy',
            price: '10.99',
            images: ['https://image.chewy.com/catalog/toy.jpg'],
            url: 'https://www.chewy.com/dp/1382534',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const meta = await fetchProductMetadata('https://www.chewy.com/dp/1382534', {
      fetchFn: mockFetch,
    });

    expect(meta.name).toBe('BARK Animal Squeakers Dog Toy');
    expect(meta.price).toBe('$10.99');
    expect(meta.image_url).toBe('https://image.chewy.com/catalog/toy.jpg');
    expect(meta.store_name).toBe('Chewy');
    expect(meta.partial).toBe(false);
  });

  it('skips TTGM grab when ENABLE_TTGM_FALLBACK=false', async () => {
    process.env.ENABLE_TTGM_FALLBACK = 'false';
    try {
      let ttgmCalled = false;
      const mockFetch = (async (input: RequestInfo | URL) => {
        const urlStr = String(input);
        if (urlStr.includes('thingstogetme.com')) {
          ttgmCalled = true;
          return new Response(JSON.stringify({ success: 'OK' }), { status: 200 });
        }
        return new Response('Blocked', { status: 429 });
      }) as unknown as typeof fetch;

      await fetchProductMetadata('https://www.chewy.com/bark-toy/dp/1382534', {
        fetchFn: mockFetch,
      });

      expect(ttgmCalled).toBe(false);
    } finally {
      delete process.env.ENABLE_TTGM_FALLBACK;
    }
  });
});
