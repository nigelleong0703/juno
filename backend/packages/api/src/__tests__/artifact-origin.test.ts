import { describe, expect, it } from 'vitest';
import { artifactCspHeader, signArtifactToken, verifyArtifactToken } from '../artifact-origin.js';

const claims = { artifactId: 'lib_a', version: 2, ownerId: 'owner-1', expiresAt: 2_000_000 };

describe('artifact render tokens', () => {
  it('round-trips and binds artifact, version and owner', () => {
    const token = signArtifactToken(claims, 'secret');
    expect(verifyArtifactToken(token, 'secret', 1_000_000)).toEqual(claims);
  });

  it('refuses expired, forged, re-signed and malformed tokens', () => {
    const token = signArtifactToken(claims, 'secret');
    expect(verifyArtifactToken(token, 'secret', 2_000_000)).toBeNull();
    expect(verifyArtifactToken(token, 'other-secret', 1_000_000)).toBeNull();
    const [payload] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, version: 1 }), 'utf8').toString('base64url');
    expect(verifyArtifactToken(`${forged}.${token.split('.')[1]}`, 'secret', 1_000_000)).toBeNull();
    expect(verifyArtifactToken(`${payload}.`, 'secret', 1_000_000)).toBeNull();
    expect(verifyArtifactToken(token + '.x', 'secret', 1_000_000)).toBeNull();
    expect(verifyArtifactToken('garbage', 'secret', 1_000_000)).toBeNull();
    expect(verifyArtifactToken(signArtifactToken(claims, ''), '', 1_000_000)).toBeNull();
  });
});

describe('artifactCspHeader', () => {
  it('allows nothing but inline code and data/blob images when the page declared no origins', () => {
    expect(artifactCspHeader(undefined, ['https://app.example'])).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-ancestors https://app.example; form-action 'none'; base-uri 'none'; sandbox allow-scripts",
    );
  });

  it('adds the declared origins to script, style, img, font and connect', () => {
    const header = artifactCspHeader({ resourceDomains: ['https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'] }, ['https://app.example', 'http://localhost:5199']);
    const both = 'https://cdn.jsdelivr.net https://fonts.gstatic.com';
    expect(header).toContain(`script-src 'unsafe-inline' ${both};`);
    expect(header).toContain(`style-src 'unsafe-inline' ${both};`);
    expect(header).toContain(`img-src data: blob: ${both};`);
    expect(header).toContain(`font-src ${both};`);
    expect(header).toContain(`connect-src ${both};`);
    expect(header).toContain('frame-ancestors https://app.example http://localhost:5199;');
    expect(header).toContain("default-src 'none'");
  });

  it('forbids framing when there are no app origins', () => {
    expect(artifactCspHeader(undefined, [])).toContain("frame-ancestors 'none'");
  });
});
