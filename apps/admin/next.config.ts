import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone çıktı — ince Docker imajı (§1 dağıtım). Yalnız Docker/Linux'ta
  // açılır: Windows'ta standalone symlink'leri EPERM verir (geliştirici modu ister).
  output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined,
  // Monorepo ortak paketi Next tarafında transpile edilir.
  transpilePackages: ['@jetlisans/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
