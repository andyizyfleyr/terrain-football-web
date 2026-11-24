import './globals.css';
import './mobile.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Terrain — Calendrier & analyse football',
  description: 'Calendrier mensuel des matchs et estimations statistiques de football.',
};

/**
 * Le rendu mobile s'appuie sur `viewport-fit=cover` (encoches et barres
 * système gérées par `env(safe-area-inset-*)`) et sur une échelle initiale
 * à 1. Le zoom utilisateur n'est volontairement PAS bloqué.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#f4f7f5' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
