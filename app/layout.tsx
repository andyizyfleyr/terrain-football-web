import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terrain — Calendrier & analyse football',
  description: 'Calendrier mensuel des matchs et estimations statistiques de football.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body>{children}</body></html>;
}
