/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  async rewrites() {
    const apiOrigin = process.env.BACKEND_API_URL || 'https://terrain-football-api.vercel.app';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};
module.exports = nextConfig;
