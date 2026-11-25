'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScoreTicker from '../components/ScoreTicker';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';
import { apiFetch, type ClientError } from '../lib/clientApi';
import { cachedLeagues, dayHeading, League, setCachedLeagues, timeOf, todayKey } from '../lib/terrain';

/* ------------------------------------------------------------------ */
/* TYPES                                                              */
/* ------------------------------------------------------------------ */

type PredictionTeam = { name: string; short: string; logo: string };

type Prediction = {
  matchId: string;
  kickoff: string;
  home: PredictionTeam;
  away: PredictionTeam;
  venue: string;
  probabilities: { home: number; draw: number; away: number };
  /** Distribution de la simulation : c'est elle que porte la confiance. */
  simulation: { home: number | null; draw: number | null; away: number | null };
  pick: 'home' | 'draw' | 'away';
  confidence: {
    score: number | null;
    label: string | null;
    /** Issue concernée par `probability` / `interval` (simulation). */
    pickKey: 'home' | 'draw' | 'away' | null;
    probability: number | null;
    interval: { low: number; high: number } | null;
  };
  lambdas: { home: number | null; away: number | null };
  synthesis: { headline: string | null; verdict: string | null; text: string | null };
  market: {
    available: boolean;
    odds: { home: number | null; draw: number | null; away: number | null };
    edge: number | null;
    valuePick: string | null;
  };
  disclosure: { verdict: string | null; headline: string | null };
  derivedMarkets: number;
  league: string;
  leagueName: string;
  leagueCountry: string;
};

type PredictionsPayload = {
  date: string;
  predictions: Prediction[];
  total: number;
  shown: number;
  withoutAnalysis: number;
  failed: string[];
  leagues: League[];
};

type QualityMetric = {
  name: string;
  accuracy: number;
  logLoss: number;
  samples: number;
  reference: boolean;
};

type Quality = {
  available: boolean;
  generatedAt: string | null;
  sample: number;
  seasons: number;
  divisions: number;
  source: string;
  metrics: QualityMetric[];
};

/* ------------------------------------------------------------------ */
/* HELPERS                                                            */
/* ------------------------------------------------------------------ */

const pct = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)} %` : '—';

const decimal = (value: number | null | undefined, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : '—';

/**
 * Trois paliers de confiance, calés sur le score MESURÉ par le moteur.
 *
 * Les seuils sont ceux du modèle (0-100) : sous 55, l'analyse manque
 * d'assise ; au-delà de 72, l'écart entre les issues est net.
 */
function confidenceTier(score: number | null | undefined): 'high' | 'medium' | 'low' {
  if (typeof score !== 'number') return 'low';
  if (score >= 72) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

const TIER_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: 'Confiance élevée',
  medium: 'Confiance moyenne',
  low: 'Confiance limitée',
};

const PICK_LABEL: Record<'home' | 'draw' | 'away', string> = {
  home: 'Domicile',
  draw: 'Nul',
  away: 'Extérieur',
};

function issueName(prediction: Prediction, key: 'home' | 'draw' | 'away'): string {
  if (key === 'home') return prediction.home.name;
  if (key === 'away') return prediction.away.name;
  return 'Match nul';
}

/** Issue retenue : celle de la simulation, qui porte la confiance. */
const pickKeyOf = (prediction: Prediction) => prediction.confidence.pickKey || prediction.pick;

/** « 12 j » : distance en jours, pour situer la journée sans la lire. */
function relativeDay(key: string, today: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const todayDate = new Date(today);
  const diff = Math.round((date.getTime() - todayDate.getTime()) / 86_400_000);
  if (diff === 0) return "aujourd'hui";
  if (diff === 1) return 'demain';
  if (diff === 2) return 'après-demain';
  if (diff > 0) return `dans ${diff} jours`;
  return `il y a ${Math.abs(diff)} jour${Math.abs(diff) > 1 ? 's' : ''}`;
}

type DayOption = { key: string; label: string; caption: string };

function buildDayOptions(today: string, count = 5): DayOption[] {
  const [y, m, d] = today.split('-').map(Number);
  const labels = ["Aujourd'hui", 'Demain', 'Après-demain'];
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(y, m - 1, d + i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
    return {
      key,
      label:
        labels[i] ||
        new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(date),
      caption: i === 0 ? 'direct' : `J+${i}`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* CARTE DE PRONOSTIC                                                 */
/* ------------------------------------------------------------------ */

function PredictionCard({ prediction, dayKey }: { prediction: Prediction; dayKey: string }) {
  const tier = confidenceTier(prediction.confidence.score);
  const pickKey = pickKeyOf(prediction);
  // La confiance porte sur `pickKey` ; si la distribution calibrée pointe
  // une AUTRE issue, la carte doit le dire plutôt que de laisser croire
  // que le badge s'applique au segment le plus long de la barre.
  const topCalibrated = (['home', 'draw', 'away'] as const).reduce((best, key) =>
    prediction.probabilities[key] > prediction.probabilities[best] ? key : best
  , 'home' as 'home' | 'draw' | 'away');
  const divergence = topCalibrated !== pickKey;
  const { home, draw, away } = prediction.probabilities;
  const market = prediction.market;
  const hasOdds = Boolean(market?.odds?.home && market?.odds?.draw && market?.odds?.away);

  return (
    <article className={`predCard predCard-${tier}`}>
      <header className="predCardHead">
        <span className="predLeague">
          {prediction.leagueName}
          {prediction.leagueCountry ? <small> · {prediction.leagueCountry}</small> : null}
        </span>
        <span
          className={`predTier predTier-${tier}`}
          title={
            prediction.confidence.score !== null
              ? `Indice de confiance interne : ${prediction.confidence.score}/100`
              : undefined
          }
        >
          <i aria-hidden="true" />
          {TIER_LABEL[tier]}
        </span>
      </header>

      <div className="predTeams">
        <div className="predTeam">
          <span className="predTeamName">{prediction.home.name}</span>
          {prediction.lambdas.home !== null ? (
            <small className="predLambda" title="Buts attendus (λ) pour cette équipe">
              λ {decimal(prediction.lambdas.home)}
            </small>
          ) : null}
        </div>
        <div className="predVs" aria-hidden="true">
          <span>{timeOf(prediction.kickoff)}</span>
          <b>VS</b>
        </div>
        <div className="predTeam predTeamAway">
          <span className="predTeamName">{prediction.away.name}</span>
          {prediction.lambdas.away !== null ? (
            <small className="predLambda" title="Buts attendus (λ) pour cette équipe">
              λ {decimal(prediction.lambdas.away)}
            </small>
          ) : null}
        </div>
      </div>

      {/* Distribution 1X2 : une seule barre, trois segments nommés. */}
      <div className="predBar" role="img" aria-label={`Domicile ${pct(home)}, nul ${pct(draw)}, extérieur ${pct(away)}`}>
        <span className="predSeg predSegHome" style={{ width: `${Math.max(2, home * 100)}%` }}>
          <b>{pct(home)}</b>
        </span>
        <span className="predSeg predSegDraw" style={{ width: `${Math.max(2, draw * 100)}%` }}>
          <b>{pct(draw)}</b>
        </span>
        <span className="predSeg predSegAway" style={{ width: `${Math.max(2, away * 100)}%` }}>
          <b>{pct(away)}</b>
        </span>
      </div>
      <div className="predLegend">
        <span style={{ width: `${home * 100}%` }}>1 · {prediction.home.short || prediction.home.name}</span>
        <span style={{ width: `${draw * 100}%` }}>N</span>
        <span style={{ width: `${away * 100}%` }}>2 · {prediction.away.short || prediction.away.name}</span>
      </div>

      <div className="predVerdict">
        <span className="predPickLabel">Issue retenue</span>
        <b>{issueName(prediction, pickKeyOf(prediction))}</b>
        {divergence ? (
          <small className="predDiverge">
            Le marché renverse l’ordre : la barre donne{' '}
            {issueName(prediction, topCalibrated)} en tête.
          </small>
        ) : null}
        {prediction.confidence.probability !== null ? (
          <small>
            réussite mesurée <b className="predMeasured">{pct(prediction.confidence.probability)}</b>
            {prediction.confidence.interval
              ? ` · intervalle ${pct(prediction.confidence.interval.low)}–${pct(
                  prediction.confidence.interval.high
                )}`
              : ''}
          </small>
        ) : (
          <small>confiance interne {prediction.confidence.score ?? '—'}/100</small>
        )}
      </div>

      {prediction.synthesis.headline || prediction.synthesis.text ? (
        <p className="predSynth">
          <b>{prediction.synthesis.headline}</b>
          {prediction.synthesis.text ? <> {prediction.synthesis.text}</> : null}
        </p>
      ) : null}

      <footer className="predFoot">
        <span className="predOdds">
          {hasOdds ? (
            <>
              <small>cotes</small> {decimal(market.odds.home)} · {decimal(market.odds.draw)} ·{' '}
              {decimal(market.odds.away)}
            </>
          ) : (
            <em>sans cote de marché</em>
          )}
        </span>
        <Link href={`/match/${encodeURIComponent(prediction.league)}/${dayKey}/${prediction.matchId}`} className="predOpen">
          Analyse complète →
        </Link>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* PAGE                                                               */
/* ------------------------------------------------------------------ */

export default function PredictionsPage() {
  const today = todayKey();
  const dayOptions = useMemo(() => buildDayOptions(today), [today]);

  const [day, setDay] = useState(today);
  const [payload, setPayload] = useState<PredictionsPayload | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [qualityUnavailable, setQualityUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState<ClientError | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [leagueFilter, setLeagueFilter] = useState<string>('all');
  const [tierFilter, setTierFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [leagues, setLeagues] = useState<League[]>(cachedLeagues || []);

  const cacheRef = useRef(new Map<string, PredictionsPayload>());

  // Qualité mesurée : chargée une fois. En cas d'absence de rapport, la
  // page n'affiche AUCUN chiffre plutôt qu'un chiffre inventé.
  useEffect(() => {
    let active = true;
    fetch('/api/model-quality')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('quality'))))
      .then((data: Quality) => {
        if (active) setQuality(data);
      })
      .catch(() => {
        if (active) setQualityUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (cachedLeagues && cachedLeagues.length > 0) {
      setLeagues(cachedLeagues);
      return;
    }
    let active = true;
    fetch('/api/leagues')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('leagues'))))
      .then(d => {
        if (!active) return;
        const list: League[] = d.leagues || [];
        setCachedLeagues(list);
        setLeagues(list);
      })
      .catch(() => {
        /* l'absence de catalogue masque seulement le filtre */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const cached = cacheRef.current.get(day);
    if (cached) {
      setPayload(cached);
      setError('');
      setFailure(null);
      setLoading(false);
      return;
    }

    let active = true;
    const load = async () => {
      setLoading(true);
      setError('');
      setFailure(null);
      const outcome = await apiFetch<PredictionsPayload>(
        `/api/predictions?date=${day.replaceAll('-', '')}`,
        { timeoutMs: 120_000 }
      );
      if (!active) return;
      if (!outcome.ok) {
        setPayload(null);
        setFailure(outcome.error);
        setError(
          outcome.error.retryable
            ? 'Les pronostics de cette journée n’ont pas pu être calculés. Réessayez dans un instant.'
            : 'Cette journée n’a pas pu être calculée.'
        );
        setLoading(false);
        return;
      }
      const next: PredictionsPayload = {
        date: outcome.data?.date || day.replaceAll('-', ''),
        predictions: (outcome.data?.predictions || []).map(prediction => ({
          ...prediction,
          simulation: prediction.simulation || { home: null, draw: null, away: null },
          confidence: {
            ...prediction.confidence,
            pickKey: prediction.confidence?.pickKey || prediction.pick,
          },
        })),
        total: outcome.data?.total ?? 0,
        shown: outcome.data?.shown ?? 0,
        withoutAnalysis: outcome.data?.withoutAnalysis ?? 0,
        failed: outcome.data?.failed || [],
        leagues: outcome.data?.leagues || [],
      };
      cacheRef.current.set(day, next);
      setPayload(next);
      if (next.leagues.length) setLeagues(prev => (prev.length ? prev : next.leagues));
      setLoading(false);
    };
    load();
    return () => {
      active = false;
    };
  }, [day, retryToken]);

  const nameOf = useCallback(
    (slug: string) => leagues.find(l => l.slug === slug)?.name || slug,
    [leagues]
  );

  /** Compétitions présentes ce jour-là, dans l'ordre du catalogue. */
  const presentLeagues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const prediction of payload?.predictions || []) {
      counts.set(prediction.league, (counts.get(prediction.league) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ slug, name: nameOf(slug), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [payload, nameOf]);

  const visible = useMemo(() => {
    return (payload?.predictions || []).filter(prediction => {
      if (leagueFilter !== 'all' && prediction.league !== leagueFilter) return false;
      if (tierFilter !== 'all' && confidenceTier(prediction.confidence.score) !== tierFilter) return false;
      return true;
    });
  }, [payload, leagueFilter, tierFilter]);

  const tierCounts = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0 };
    for (const prediction of payload?.predictions || []) {
      counts[confidenceTier(prediction.confidence.score)] += 1;
    }
    return counts;
  }, [payload]);

  const selectedDay = dayOptions.find(option => option.key === day);
  const dayTitle = selectedDay?.label || dayHeading(day);
  const topPick = payload?.predictions?.[0];

  // Référence de lecture du bloc qualité : le modèle calibré face au marché.
  const calibrated = quality?.metrics.find(m => /calibré/i.test(m.name));
  const marketRef = quality?.metrics.find(m => m.reference);

  return (
    <main className="appShell">
      <a
        className="skipLink"
        href="#pronostics"
        onClick={event => {
          event.preventDefault();
          const target = document.getElementById('pronostics');
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }}
      >
        Aller aux pronostics
      </a>

      <SiteHeader
        items={[
          { kind: 'link', href: '/', label: 'Rencontres' },
          { kind: 'link', href: '/matchs', label: 'Tous les matchs' },
          { kind: 'current', label: 'Pronostics' },
        ]}
        quickAction={{ href: '/matchs', label: '← Matchs' }}
      />

      <ScoreTicker />

      <section className="predIntro">
        <div className="eyebrow">
          <span /> MODÈLE QUANTITATIF · {leagues.length || 23} COMPÉTITIONS
        </div>
        <h1>Pronostics</h1>
        <p>
          Chaque carte est la sortie du modèle : une distribution 1X2 issue de la simulation,
          un score de confiance <b>mesuré</b> sur backtest, et l’écart au marché quand une cote
          publique existe. Aucune estimation n’est présentée comme une certitude.
        </p>
      </section>

      <nav className="dayPicker" aria-label="Choisir une journée">
        <div className="dayPickerScroll" role="tablist">
          {dayOptions.map(option => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={option.key === day}
              className={`dayChip ${option.key === day ? 'dayChipActive' : ''}`}
              onClick={() => setDay(option.key)}
            >
              <small>{option.caption}</small>
              <b>{option.label}</b>
            </button>
          ))}
        </div>
        <label className="dayPickerDate">
          <span>Autre date</span>
          <input
            type="date"
            value={day}
            aria-label="Choisir une autre date"
            onChange={event => {
              if (event.target.value) setDay(event.target.value);
            }}
          />
        </label>
      </nav>

      <div className="predLayout">
        <section className="predMain" id="pronostics">
          <div className="sectionHeader predHeader">
            <div>
              <span className="sectionKicker">{dayHeading(day).toUpperCase()}</span>
              <h2>{dayTitle}</h2>
              <p>
                {error ? (
                  <span className="inlineError">
                    {error}
                    {failure?.retryable ? (
                      <button type="button" className="inlineRetry" onClick={() => setRetryToken(t => t + 1)}>
                        Réessayer
                      </button>
                    ) : null}
                  </span>
                ) : loading ? (
                  <>
                    <i className="tinySpinner" /> Simulation en cours sur les compétitions du jour…
                  </>
                ) : (
                  <>
                    {payload?.total || 0} pronostic{(payload?.total || 0) > 1 ? 's' : ''} ·{' '}
                    {presentLeagues.length} compétition{presentLeagues.length > 1 ? 's' : ''} ·{' '}
                    triés par confiance
                    {payload?.failed?.length ? (
                      <span className="allMatchesPartial">
                        {' '}
                        · {payload.failed.length} compétition
                        {payload.failed.length > 1 ? 's' : ''} non analysée
                        {payload.failed.length > 1 ? 's' : ''}
                      </span>
                    ) : null}
                  </>
                )}
              </p>
            </div>
            <span className="dayCount">
              {visible.length} affiché{visible.length > 1 ? 's' : ''}
            </span>
          </div>

          {/* Filtres : compétition puis palier de confiance. */}
          {!loading && (payload?.predictions?.length || 0) > 0 ? (
            <div className="predFilters">
              <div className="leagueFilterBar" role="group" aria-label="Filtrer par compétition">
                <button
                  type="button"
                  className={`leagueChip ${leagueFilter === 'all' ? 'leagueChipOn' : 'leagueChipOff'}`}
                  aria-pressed={leagueFilter === 'all'}
                  onClick={() => setLeagueFilter('all')}
                >
                  Toutes
                  <b>{payload?.predictions?.length || 0}</b>
                </button>
                {presentLeagues.map(item => (
                  <button
                    key={item.slug}
                    type="button"
                    className={`leagueChip ${leagueFilter === item.slug ? 'leagueChipOn' : 'leagueChipOff'}`}
                    aria-pressed={leagueFilter === item.slug}
                    onClick={() => setLeagueFilter(leagueFilter === item.slug ? 'all' : item.slug)}
                  >
                    {item.name}
                    <b>{item.count}</b>
                  </button>
                ))}
              </div>
              <div className="predTiers" role="group" aria-label="Filtrer par confiance">
                {(['all', 'high', 'medium', 'low'] as const).map(tier => (
                  <button
                    key={tier}
                    type="button"
                    className={`predTierBtn predTierBtn-${tier} ${
                      tierFilter === tier ? 'predTierBtnOn' : ''
                    }`}
                    aria-pressed={tierFilter === tier}
                    onClick={() => setTierFilter(tier)}
                  >
                    {tier === 'all' ? 'Toutes' : TIER_LABEL[tier]}
                    <b>{tier === 'all' ? payload?.predictions?.length || 0 : tierCounts[tier]}</b>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="emptyState">
              <span className="emptyIcon">⌁</span>
              <b>Calcul impossible pour cette journée</b>
              <span>Changez de date ou réessayez dans un instant.</span>
            </div>
          ) : loading ? (
            <div className="emptyState">
              <i className="largeSpinner" />
              <b>Simulation de {dayTitle.toLowerCase()}</b>
              <span>
                Le moteur simule chaque rencontre puis mesure sa confiance. Cela prend quelques
                secondes pour {leagues.length || 23} compétitions.
              </span>
            </div>
          ) : (payload?.predictions?.length || 0) === 0 ? (
            <div className="emptyState">
              <span className="emptyIcon">⌁</span>
              <b>Aucun pronostic sur cette journée</b>
              <span>
                {payload?.withoutAnalysis
                  ? `${payload.withoutAnalysis} rencontre(s) n’ont pas reçu d’analyse du moteur : sans cote ni données suffisantes, aucun pronostic n’est publié.`
                  : 'Aucune des compétitions suivies ne joue à cette date, ou aucune donnée n’est encore disponible.'}
              </span>
            </div>
          ) : visible.length === 0 ? (
            <div className="emptyState">
              <span className="emptyIcon">⌕</span>
              <b>Aucun pronostic ne correspond au filtre</b>
              <span>Élargissez la compétition ou le niveau de confiance.</span>
            </div>
          ) : (
            <div className="predGrid">
              {visible.map(prediction => (
                <PredictionCard
                  key={`${prediction.league}-${prediction.matchId}`}
                  prediction={prediction}
                  dayKey={day}
                />
              ))}
            </div>
          )}

          <p className="panelDisclaimer">
            Probabilités estimées par un modèle statistique : jamais des certitudes. Le score de
            confiance mesure l’accord interne du modèle, pas la réalité du résultat.
          </p>
        </section>

        {/* ---- Colonne de contexte ---- */}
        <aside className="predSide">
          {quality?.available ? (
            <section className="predPanel predQuality">
              <header className="predPanelHead">
                <span className="sectionKicker">CE QUE VAUT LE MODÈLE</span>
                <b>{calibrated ? pct(calibrated.accuracy) : '—'}</b>
                <small>d’issues exactes</small>
              </header>
              <p className="predQualityNote">
                Mesuré sur <b>{quality.sample.toLocaleString('fr-FR')}</b> matchs réels
                ({quality.seasons} saisons, {quality.divisions} championnats), hors échantillon.
              </p>
              <ul className="predQualityList">
                {quality.metrics.map(metric => (
                  <li key={metric.name} className={metric.reference ? 'predQualityRef' : undefined}>
                    <span>{metric.name}</span>
                    <b>{pct(metric.accuracy)}</b>
                    <small>log-loss {decimal(metric.logLoss, 3)}</small>
                  </li>
                ))}
              </ul>
              <p className="predQualityFoot">
                {marketRef && calibrated && calibrated.accuracy >= marketRef.accuracy
                  ? 'Le modèle égale la référence de marché sans la dépasser significativement'
                  : 'Le modèle reste derrière la référence de marché'}
                {' — '}
                c’est mesuré, pas promis : les paris à « valeur » restent désactivés tant que
                l’écart n’est pas démontré.
              </p>
            </section>
          ) : qualityUnavailable ? (
            <section className="predPanel">
              <header className="predPanelHead">
                <span className="sectionKicker">CE QUE VAUT LE MODÈLE</span>
              </header>
              <p className="predQualityNote">
                Aucun rapport de backtest n’est disponible : la précision du modèle n’est pas
                affichée plutôt que d’être annoncée sans preuve.
              </p>
            </section>
          ) : null}

          {topPick ? (
            <section className="predPanel predTop">
              <header className="predPanelHead">
                <span className="sectionKicker">PRONOSTIC DU JOUR</span>
              </header>
              <p className="predTopLeague">{topPick.leagueName}</p>
              <div className="predTopTeams">
                <b>{topPick.home.name}</b>
                <span>vs</span>
                <b>{topPick.away.name}</b>
              </div>
              <div className="predTopPick">
                <span>Issue retenue</span>
                <b>{issueName(topPick, pickKeyOf(topPick))}</b>
              </div>
              <ul className="predTopStats">
                <li>
                  <span>Confiance</span>
                  <b>{topPick.confidence.score ?? '—'}/100</b>
                </li>
                <li>
                  <span>Probabilité</span>
                  <b>{pct(topPick.confidence.probability)}</b>
                </li>
                <li>
                  <span>Buts attendus</span>
                  <b>
                    {decimal(topPick.lambdas.home)} – {decimal(topPick.lambdas.away)}
                  </b>
                </li>
              </ul>
              {topPick.synthesis.text ? <p className="predTopText">{topPick.synthesis.text}</p> : null}
            </section>
          ) : null}

          <section className="predPanel predHow">
            <header className="predPanelHead">
              <span className="sectionKicker">COMMENT C’EST CALCULÉ</span>
            </header>
            <ol className="predHowList">
              <li>
                <b>Forme &amp; xG</b>
                <span>Résultats récents et buts attendus, sur une fenêtre de 60 jours.</span>
              </li>
              <li>
                <b>Effectif</b>
                <span>Blessés, suspendus et incertains, pondérés par leur valeur dans l’équipe.</span>
              </li>
              <li>
                <b>Contexte</b>
                <span>Avantage du terrain, confrontations directes, enjeu au classement.</span>
              </li>
              <li>
                <b>Simulation</b>
                <span>
                  Score final simulé 10 000 fois, puis calibré contre le marché quand une cote
                  publique existe.
                </span>
              </li>
            </ol>
            <p className="predHowFootnote">
              Sans cote de marché, la distribution reste celle du modèle seul : elle est alors
              plus large, et la confiance affichée le reflète.
            </p>
          </section>
        </aside>
      </div>

      <SiteFooter />
    </main>
  );
}
