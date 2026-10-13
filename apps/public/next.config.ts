import path from 'node:path';
import type { NextConfig } from 'next';

// The Content-Security-Policy carries a per-request nonce, so it is set in
// proxy.ts with the rest of the page headers; these cover every other path.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Docker image (apps/Dockerfile): a self-contained server, traced from the
  // repo root so the workspace packages come along.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  transpilePackages: ['@jiwar/bff'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
