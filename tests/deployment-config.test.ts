import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Unraid & Docker Deployment Artifacts', () => {
  const root = path.resolve(__dirname, '..');

  it('provides Dockerfile, docker-compose.yml, .env.example, and valid Unraid XML template mapping /data', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain('EXPOSE 3000');

    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('/data');
    expect(compose).toContain('GOOGLE_CLIENT_ID');
    expect(compose).toContain('FACEBOOK_CLIENT_ID');
    expect(compose).toContain('AMAZON_CLIENT_ID');
    expect(compose).toContain('BROWSERLESS_URL');

    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(envExample).toContain('BROWSERLESS_URL=');
    expect(envExample).toContain('USER_AGENT=');

    const unraidXml = fs.readFileSync(path.join(root, 'unraid-template.xml'), 'utf8');
    expect(unraidXml).toContain('<Container version="2">');
    expect(unraidXml).toContain('/mnt/user/appdata/family-wishlist');
    expect(unraidXml).toContain('BROWSERLESS_URL');
    expect(unraidXml).toContain('USER_AGENT');
    expect(unraidXml).toContain('<Icon>https://raw.githubusercontent.com/death2all110/focused-babbage/main/public/icon.png</Icon>');

    // Icons and favicons exist
    expect(fs.existsSync(path.join(root, 'public', 'icon.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public', 'icon.svg'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public', 'favicon.ico'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public', 'favicon.svg'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public', 'favicon-32x32.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'public', 'apple-touch-icon.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'icon.png'))).toBe(true);
  });
});
