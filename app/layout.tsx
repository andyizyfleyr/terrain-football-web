import './globals.css';
import './design-refresh.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terrain — Analyse football',
  description: 'Analyses de matchs et estimations football fondées sur les données publiques ESPN.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body>{children}</body></html>;
}
