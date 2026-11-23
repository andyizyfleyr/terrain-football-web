/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  async rewrites() {
    const apiOrigin = process.env.BACKEND_API_URL || 'http://127.0.0.1:8000';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};
module.exports = nextConfig;
