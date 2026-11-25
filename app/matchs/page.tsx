'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MatchCard } from '../components/MatchCard';
import { SiteFooter, SiteHeader } from '../components/SiteHeader';
import { apiFetch, type ClientError } from '../lib/clientApi';
import {
  buildMatchUrl,
  cachedLeagues,
  dayHeading,
  Fixture,
  isFixtureFinished,
  League,
  setCachedLeagues,
  todayKey,
} from '../lib/terrain';

/** Rencontre telle que servie par `/api/fixtures/all`. */
type CrossLeagueFixture = Fixture & {
  league: string;
  leagueName: string;
  leagueCountry?: string;
  leagueTier?: number;
};

type DayPayload = {
  date: string;
  events: CrossLeagueFixture[];
  leagues: League[];
  perLeague: Record<string, number>;
  failed: string[];
  total: number;
};

/** Nombre de jours proposés dans la barre de dates (aujourd'hui inclus). */
const DAY_WINDOW = 10;

type DayOption = {
  key: string;
  label: string;
  caption: string;
};

const shortWeekday = (d: Date) =>
  ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'][d.getDay()];

const shortMonth = (d: Date) =>
  ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'][
    d.getMonth()
  ];

/**
 * Libellé relatif d'une journée : « Aujourd'hui », « Demain »… puis la
 * date. Journées absolues et non relatives au chargement : la page peut
 * rester ouverte au-delà de minuit, `dayOptions` est donc recalculé à
 * chaque rendu à partir de `todayKey()`.
 */
function dayLabel(key: string, today: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (key === today) return "Aujourd'hui";
  const todayDate = new Date(today);
  const diff = Math.round((date.getTime() - todayDate.getTime()) / 86_400_000);
  if (diff === 1) return 'Demain';
  if (diff === 2) return 'Après-demain';
  return `${shortWeekday(date)} ${d} ${shortMonth(date)}`;
}

function buildDayOptions(today: string): DayOption[] {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: DAY_WINDOW }, (_, i) => {
    const date = new Date(y, m - 1, d + i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
    return {
      key,
      label: dayLabel(key, today),
      caption: i === 0 ? 'direct' : `${i} j`,
    };
  });
}

export default function AllMatchesPage() {
  const today = todayKey();
  const dayOptions = useMemo(() => buildDayOptions(today), [today]);

  const [day, setDay] = useState(today);
  const [payload, setPayload] = useState<DayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState<ClientError | null>(null);
  const [search, setSearch] = useState('');
  /** Compétitions masquées par l'utilisateur. */
  const [hiddenLeagues, setHiddenLeagues] = useState<string[]>([]);
  const [leagues, setLeagues] = useState<League[]>(cachedLeagues || []);
  const [retryToken, setRetryToken] = useState(0);

  /** Cache mémoire : revenir sur une journée déjà consultée est instantané. */
  const dayCacheRef = useRef(new Map<string, DayPayload>());

  // Catalogue : il sert à proposer le filtre de compétitions et les noms
  // lisibles. La réponse de `/api/fixtures/all` en porte déjà, mais elle
  // arrive avec le premier jour chargé.
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
        /* Le filtre de compétitions reste alors masqué : le reste de la page
           n'en dépend pas. */
      });
    return () => {
      active = false;
    };
  }, []);

  // Chargement de la journée sélectionnée.
  useEffect(() => {
    const cached = dayCacheRef.current.get(day);
    if (cached) {
      setPayload(cached);
      setLeagues(prev => (prev.length ? prev : cached.leagues || []));
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
      const outcome = await apiFetch<DayPayload>(
        `/api/fixtures/all?date=${day.replaceAll('-', '')}`,
        { timeoutMs: 25_000 }
      );
      if (!active) return;
      if (!outcome.ok) {
        setPayload(null);
        setFailure(outcome.error);
        setError(
          outcome.error.retryable
            ? 'Les matchs de cette journée n’ont pas pu être chargés. Vérifiez votre connexion puis réessayez.'
            : 'Cette journée n’a pas pu être chargée.'
        );
        setLoading(false);
        return;
      }
      const next: DayPayload = {
        date: outcome.data?.date || day.replaceAll('-', ''),
        events: outcome.data?.events || [],
        leagues: outcome.data?.leagues || [],
        perLeague: outcome.data?.perLeague || {},
        failed: outcome.data?.failed || [],
        total: outcome.data?.total ?? (outcome.data?.events || []).length,
      };
      dayCacheRef.current.set(day, next);
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

  /** Sections par compétition, dans l'ordre du catalogue. */
  const sections = useMemo(() => {
    const events = (payload?.events || []).filter(item => !hiddenLeagues.includes(item.league));
    const byLeague = new Map<string, CrossLeagueFixture[]>();
    for (const item of events) {
      const list = byLeague.get(item.league);
      if (list) list.push(item);
      else byLeague.set(item.league, [item]);
    }
    const order = new Map(leagues.map((l, i) => [l.slug, i]));
    return Array.from(byLeague.entries())
      .map(([slug, items]) => ({
        slug,
        name: items[0]?.leagueName || nameOf(slug),
        country: items[0]?.leagueCountry || leagues.find(l => l.slug === slug)?.country || '',
        items,
      }))
      .sort(
        (a, b) =>
          (order.get(a.slug) ?? 999) - (order.get(b.slug) ?? 999) || a.name.localeCompare(b.name)
      );
  }, [payload, hiddenLeagues, leagues, nameOf]);

  /** Filtre de recherche (équipe, stade, compétition) appliqué aux cartes. */
  const query = search.trim().toLowerCase();
  const matchesQuery = useCallback(
    (item: CrossLeagueFixture) =>
      !query ||
      `${item.home?.name || ''} ${item.away?.name || ''} ${item.venue || ''} ${
        item.leagueName || ''
      }`
        .toLowerCase()
        .includes(query),
    [query]
  );

  const visibleBySection = useMemo(
    () =>
      sections
        .map(section => ({ ...section, items: section.items.filter(matchesQuery) }))
        .filter(section => section.items.length > 0),
    [sections, matchesQuery]
  );

  const visibleCount = visibleBySection.reduce((sum, s) => sum + s.items.length, 0);
  const totalEvents = payload?.events?.length || 0;
  const finishedCount = (payload?.events || []).filter(isFixtureFinished).length;

  /** Compétitions présentes ce jour-là, avec leur nombre de matchs. */
  const presentLeagues = useMemo(() => {
    const map = new Map<string, { slug: string; name: string; count: number }>();
    for (const item of payload?.events || []) {
      const existing = map.get(item.league);
      if (existing) existing.count += 1;
      else map.set(item.league, { slug: item.league, name: item.leagueName || nameOf(item.league), count: 1 });
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [payload, nameOf]);

  const toggleLeague = (slug: string) => {
    setHiddenLeagues(prev => (prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]));
  };

  const selectedDay = dayOptions.find(option => option.key === day);
  const dayTitle = dayHeading(day);

  return (
    <main className="appShell">
      <a
        className="skipLink"
        href="#tous-les-matchs"
        onClick={event => {
          event.preventDefault();
          const target = document.getElementById('tous-les-matchs');
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }}
      >
        Aller aux matchs
      </a>

      <SiteHeader
        items={[
          { kind: 'link', href: '/', label: 'Rencontres' },
          { kind: 'current', label: 'Tous les matchs' },
          { kind: 'link', href: '/pronostics', label: 'Pronostics' },
        ]}
        quickAction={{ href: '/', label: '← Rencontres' }}
      />

      <section className="allMatchesIntro">
        <div className="eyebrow">
          <span /> TOUTES LES COMPÉTITIONS · {leagues.length || 23} LIGUES SUIVIES
        </div>
        <h1>Tous les matchs du jour</h1>
        <p>
          Une seule vue pour les {leagues.length || 23} compétitions du catalogue : choisissez une
          journée, filtrez par compétition ou par équipe, puis ouvrez une rencontre pour son analyse.
        </p>
      </section>

      {/* ---- Sélecteur de journée ---- */}
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

      <section className="allMatchesPanel" id="tous-les-matchs">
        <div className="sectionHeader allMatchesHeader">
          <div>
            <span className="sectionKicker">{dayTitle.toUpperCase()}</span>
            <h2>{selectedDay ? selectedDay.label : dayTitle}</h2>
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
                  <i className="tinySpinner" /> Chargement des matchs de toutes les compétitions…
                </>
              ) : (
                <>
                  {totalEvents} rencontre{totalEvents > 1 ? 's' : ''} · {finishedCount} terminée
                  {finishedCount > 1 ? 's' : ''} · {presentLeagues.length} compétition
                  {presentLeagues.length > 1 ? 's' : ''} · heures de Cotonou
                  {payload?.failed?.length ? (
                    <span className="allMatchesPartial">
                      {' '}
                      · {payload.failed.length} compétition
                      {payload.failed.length > 1 ? 's' : ''} non vérifiée
                      {payload.failed.length > 1 ? 's' : ''}
                    </span>
                  ) : null}
                </>
              )}
            </p>
          </div>
          <div className="allMatchesActions">
            <label className="matchSearch allMatchesSearch">
              <span>⌕</span>
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Rechercher une équipe ou un stade"
                aria-label="Rechercher une rencontre"
                autoComplete="off"
              />
            </label>
            <span className="dayCount">
              {visibleCount} match{visibleCount !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Filtres de compétitions : pastilles désactivables. */}
        {!loading && presentLeagues.length > 0 ? (
          <div className="leagueFilterBar" role="group" aria-label="Filtrer par compétition">
            {presentLeagues.map(item => {
              const hidden = hiddenLeagues.includes(item.slug);
              return (
                <button
                  key={item.slug}
                  type="button"
                  className={`leagueChip ${hidden ? 'leagueChipOff' : ''}`}
                  aria-pressed={!hidden}
                  onClick={() => toggleLeague(item.slug)}
                  title={hidden ? 'Réafficher cette compétition' : 'Masquer cette compétition'}
                >
                  {item.name}
                  <b>{item.count}</b>
                </button>
              );
            })}
            {hiddenLeagues.length > 0 ? (
              <button type="button" className="tagFilterReset" onClick={() => setHiddenLeagues([])}>
                Tout réafficher
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="emptyState">
            <span className="emptyIcon">⚽</span>
            <b>Impossible d’afficher cette journée</b>
            <span>Changez de date ou réessayez dans un instant.</span>
          </div>
        ) : loading ? (
          <div className="emptyState">
            <i className="largeSpinner" />
            <b>Chargement de {selectedDay ? selectedDay.label.toLowerCase() : dayTitle}</b>
            <span>Interrogation des {leagues.length || 23} compétitions du catalogue…</span>
          </div>
        ) : totalEvents === 0 ? (
          <div className="emptyState">
            <span className="emptyIcon">⚽</span>
            <b>Aucune rencontre ce jour-là</b>
            <span>
              {payload?.failed?.length
                ? `${payload.failed.length} compétition(s) n’ont pas pu être vérifiées : il peut manquer des matchs.`
                : 'Aucune des compétitions suivies ne joue à cette date. Essayez une autre journée.'}
            </span>
          </div>
        ) : visibleCount === 0 ? (
          <div className="emptyState">
            <span className="emptyIcon">⌕</span>
            <b>Aucune rencontre ne correspond au filtre</b>
            <span>
              {query
                ? `Aucune équipe, aucun stade ni aucune compétition ne correspond à « ${search.trim()} ».`
                : 'Toutes les compétitions sont masquées : réaffichez-en une pour voir ses matchs.'}
            </span>
          </div>
        ) : (
          <>
            <div className="dayGroups">
              {visibleBySection.map(section => (
                <section className="dayGroup" key={section.slug}>
                  <header className="dayGroupHead">
                    <b>
                      <Link href={`/?league=${encodeURIComponent(section.slug)}`}>{section.name}</Link>
                      {section.country ? <small> · {section.country}</small> : null}
                    </b>
                    <span>
                      {section.items.length} rencontre{section.items.length > 1 ? 's' : ''}
                    </span>
                  </header>
                  <div className="dayGroupList">
                    {section.items.map(item => (
                      <MatchCard
                        key={`${item.league}-${item.id}`}
                        fixture={item}
                        href={buildMatchUrl(item.league, day, item.id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <p className="panelDisclaimer">
              Les scores de vigilance sont des signaux exploratoires, pas des preuves de manipulation.
            </p>
          </>
        )}
      </section>

      <SiteFooter />
    </main>
  );
}
