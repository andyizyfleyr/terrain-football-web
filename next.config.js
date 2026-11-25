/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  async rewrites() {
    const apiOrigin = process.env.BACKEND_API_URL || 'https://terrain-football-api.vercel.app';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  // Les rapports de validation (marchés dérivés) sont lus au runtime par
  // la route `/api/markets/validation`. Sur Vercel, le traçage de fichiers
  // doit les inclure explicitement dans le bundle de la fonction, sinon la
  // route répondrait 404 en production alors qu'elle fonctionne en local.
  outputFileTracingIncludes: {
    '/api/markets/validation': ['./data/markets-validation.json'],
    // La page Pronostics affiche la précision MESURÉE du modèle : sans le
    // rapport de backtest dans le bundle, la route répondrait 404 en
    // production et le bloc de transparence disparaîtrait.
    '/api/model-quality': ['./data/backtest-report.json'],
  },
};
module.exports = nextConfig;
