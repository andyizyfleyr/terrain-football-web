'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

/* ------------------------------------------------------------------ */
/* TYPES                                                              */
/* ------------------------------------------------------------------ */

type TickerTeam = { name: string; short: string; score: number | null };

type TickerEvent = {
  id: string;
  date: string;
  /** Slug de compétition (`eng.1`) : c'est ce que comprend la page d'accueil. */
  league?: string;
  leagueName?: string;
  home: TickerTeam;
  away: TickerTeam;
  /** Contrat réel de `/api/fixtures/all` : ESPN `status.type`. */
  status?: { state?: string; completed?: boolean; detail?: string };
};

type FixturesAll = {
  date: string;
  events?: TickerEvent[];
};

type Row = {
  id: string;
  state: 'pre' | 'in' | 'post';
  league: string;
  leagueName: string;
  homeName: string;
  awayName: string;
  homeScore: number | null;
  awayScore: number | null;
  clock: string;
  live: boolean;
  finished: boolean;
  kickoff: string;
};

/* ------------------------------------------------------------------ */
/* HELPERS                                                            */
/* ------------------------------------------------------------------ */

/**
 * ESPN distingue trois états : `pre` (à venir), `in` (en cours),
 * `post` (terminé). Toute autre valeur est traitée comme « à venir ».
 */
function stateOf(event: TickerEvent): 'pre' | 'in' | 'post' {
  const state = event.status?.state;
  if (state === 'in') return 'in';
  if (state === 'post' || event.status?.completed) return 'post';
  return 'pre';
}

function clockOf(event: TickerEvent, state: 'pre' | 'in' | 'post'): string {
  const detail = event.status?.detail;
  if (state === 'post') return detail && detail !== 'Full Time' ? detail : 'Term.';
  if (state === 'in') return detail || 'En cours';
  const date = new Date(event.date);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  }).format(date);
}

function toRow(event: TickerEvent): Row | null {
  if (!event?.home || !event?.away) return null;
  const state = stateOf(event);
  const finished = state === 'post';
  const live = state === 'in';
  const scored = state !== 'pre';
  return {
    id: String(event.id),
    state,
    league: event.league || '',
    leagueName: event.leagueName || '',
    homeName: event.home.short || event.home.name,
    awayName: event.away.short || event.away.name,
    // ESPN renvoie `score: 0` avant le coup d'envoi : afficher « 0 – 0 »
    // pour un match qui n'a pas commencé serait un score inventé.
    homeScore: scored && typeof event.home.score === 'number' ? event.home.score : null,
    awayScore: scored && typeof event.away.score === 'number' ? event.away.score : null,
    clock: clockOf(event, state),
    live,
    finished,
    kickoff: event.date,
  };
}

/* ------------------------------------------------------------------ */
/* TICKER                                                             */
/* ------------------------------------------------------------------ */

/**
 * Bandeau collant des scores du jour, toutes compétitions.
 *
 * Il s'affiche sous l'en-tête, sur la page d'accueil uniquement, et
 * s'efface quand aucune rencontre n'est disponible : une barre vide
 * coûte de la hauteur sans rien dire.
 */
export default function ScoreTicker() {
  const [events, setEvents] = useState<TickerEvent[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [hidden, setHidden] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);
  /**
   * Durée de défilement calculée sur la largeur RÉELLE d'une copie du
   * rail : à durée fixe, un bandeau chargé défilerait à toute vitesse et
   * un bandeau court ramperait. On vise ~42 px/s.
   */
  const [duration, setDuration] = useState(90);

  useEffect(() => {
    let active = true;
    const date = new Date();
    const key = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
      date.getDate()
    ).padStart(2, '0')}`;

    fetch(`/api/fixtures/all?date=${key}`)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error('fixtures'))))
      .then((data: FixturesAll) => {
        if (!active) return;
        const list = Array.isArray(data?.events) ? data.events : [];
        setEvents(list);
        setStatus(list.length ? 'ready' : 'empty');
      })
      .catch(() => {
        if (active) setStatus('error');
      });

    return () => {
      active = false;
    };
  }, []);

  const rows = useMemo(() => {
    const mapped = events
      .map(toRow)
      .filter((row): row is Row => Boolean(row));
    // Les rencontres en cours d'abord, puis les terminées, puis le reste :
    // un bandeau de scores sert à savoir ce qui se passe MAINTENANT.
    return mapped.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return (a.kickoff || '').localeCompare(b.kickoff || '');
    });
  }, [events]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || hidden) return;
    const measure = () => {
      // Le rail contient deux copies : une demi-largeur = une boucle.
      const half = rail.scrollWidth / 2;
      if (!half) return;
      const seconds = Math.min(220, Math.max(38, half / 42));
      setDuration(Math.round(seconds));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [hidden, rows.length]);

  if (hidden || status === 'empty' || status === 'error' || !rows.length) {
    return null;
  }

  const liveCount = rows.filter(row => row.live).length;
  // Deux copies : la seconde prend le relais quand la première sort de
  // l'écran. Le défilement est purement CSS, donc coupé par
  // `prefers-reduced-motion`.
  const loop = [...rows, ...rows];

  return (
    <div className="tickerBar" role="region" aria-label="Scores du jour">
      <div className="tickerLead">
        <i className={liveCount ? 'tickerDot tickerDotLive' : 'tickerDot'} aria-hidden="true" />
        <span>{liveCount ? `${liveCount} en direct` : 'Scores du jour'}</span>
      </div>

      <div className="tickerTrack" aria-hidden="false">
        <div className="tickerRail" ref={railRef} style={{ '--tickerDuration': `${duration}s` } as CSSProperties}>
          {loop.map((row, index) => (
            <a
              className={`tickerItem ${row.live ? 'tickerItemLive' : ''}`}
              key={`${row.id}-${index}`}
              href={row.league ? `/?league=${encodeURIComponent(row.league)}#rencontres` : '#rencontres'}
              tabIndex={index < rows.length ? 0 : -1}
            >
              <span className="tickerLeague">{row.leagueName || row.league || 'Football'}</span>
              <span className="tickerScore">
                <b>{row.homeName}</b>
                <em>
                  {row.homeScore !== null && row.awayScore !== null
                    ? `${row.homeScore} – ${row.awayScore}`
                    : row.state === 'post'
                    ? '—'
                    : 'vs'}
                </em>
                <b>{row.awayName}</b>
              </span>
              <span className={`tickerClock ${row.live ? 'tickerClockLive' : ''}`}>{row.clock}</span>
              {index === rows.length - 1 ? <span className="tickerBreak" aria-hidden="true" /> : null}
            </a>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="tickerClose"
        aria-label="Masquer le bandeau des scores"
        onClick={() => setHidden(true)}
      >
        ×
      </button>
    </div>
  );
}
