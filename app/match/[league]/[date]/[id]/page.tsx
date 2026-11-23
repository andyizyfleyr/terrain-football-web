'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MatchAnalysisPanel } from '../../../../components/MatchAnalysisPanel';
import { cachedLeagues, League, readResumeSnapshot, setCachedLeagues } from '../../../../lib/terrain';

export default function MatchAnalysisPage() {
  const params = useParams<{ league: string; date: string; id: string }>();
  const router = useRouter();

  const leagueSlug = decodeURIComponent(params?.league || 'eng.1');
  const dayKey = decodeURIComponent(params?.date || '');
  const matchId = decodeURIComponent(params?.id || '');

  const [leagues, setLeagues] = useState<League[]>(cachedLeagues || []);

  useEffect(() => {
    if (cachedLeagues && cachedLeagues.length > 0) return;
    fetch('/api/leagues')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.leagues) {
          setCachedLeagues(d.leagues);
          setLeagues(d.leagues);
        }
      })
      .catch(() => {});
  }, []);

  const leagueName = leagues.find(item => item.slug === leagueSlug)?.name || leagueSlug;

  const handleBack = () => {
    const resume = readResumeSnapshot();
    if (typeof window !== 'undefined' && window.history.length > 1 && resume) {
      router.back();
    } else {
      const monthParam = dayKey ? dayKey.slice(0, 7) : '';
      const qs = new URLSearchParams();
      if (leagueSlug) qs.set('league', leagueSlug);
      if (monthParam) qs.set('month', monthParam);
      router.push(`/${qs.toString() ? `?${qs.toString()}` : ''}`);
    }
  };

  return (
    <main className="appShell matchPageShell">
      <header className="appHeader">
        <Link className="brand" href="/" aria-label="Terrain, accueil">
          <span className="brandMark">T</span>
          <span className="brandWords">
            TERRAIN
            <small>FOOTBALL INTELLIGENCE</small>
          </span>
        </Link>
        <nav className="mainNav" aria-label="Navigation principale">
          <button type="button" className="navLinkButton" onClick={handleBack}>
            ← Rencontres
          </button>
          <span className="navCurrent">Analyse</span>
        </nav>
      </header>

      <div className="matchPageBody">
        <MatchAnalysisPanel
          leagueSlug={leagueSlug}
          leagueName={leagueName}
          dayKey={dayKey}
          matchId={matchId}
          onClose={handleBack}
          closeLabel="Retour à la liste des matchs"
        />
      </div>

      <footer className="appFooter">
        <span>© TERRAIN · FOOTBALL INTELLIGENCE</span>
        <span>DONNÉES STATISTIQUES PUBLIQUES · ESTIMATIONS, JAMAIS DES CERTITUDES</span>
      </footer>
    </main>
  );
}
