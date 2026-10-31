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

    const unraidXml = fs.readFileSync(path.join(root, 'unraid-template.xml'), 'utf8');
    expect(unraidXml).toContain('<Container version="2">');
    expect(unraidXml).toContain('/mnt/user/appdata/family-wishlist');
  });
});
