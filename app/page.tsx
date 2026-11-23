'use client';

import { useEffect, useMemo, useState } from 'react';

type League = { slug: string; name: string; country: string; tier: number };
type Team = { id: string; name: string; short: string; logo?: string; score: number | null };
type Fixture = { id: string; date: string; name: string; home: Team; away: Team; venue?: string; city?: string; odds?: any };
type MonthFixture = Fixture & { dayKey: string };
type DayEvents = Record<string, Fixture[]>;

const pad = (n: number) => String(n).padStart(2, '0');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const keyFor = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
const monthLabel = (value: string) => new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(`${value}-01T12:00:00`));
const longDate = (value: string) => value ? new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : '';
const shortDate = (value: string) => new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
const timeOf = (value: string) => value ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Porto-Novo' }).format(new Date(value)) : 'Heure à confirmer';
const pct = (value: any) => typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';

function TeamBadge({ team, size = 36 }: { team?: Team; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [team?.id, team?.logo]);
  const logo = team?.logo || (team?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${team.id}.png` : '');
  return <span className="teamBadge" style={{ width: size, height: size }}>
    {logo && !broken ? <img src={logo} alt={`${team?.name || 'Équipe'} — logo`} loading="lazy" onError={() => setBroken(true)} /> : <span>{(team?.short || team?.name || '?').slice(0, 3)}</span>}
  </span>;
}

function ProbBar({ label, value, color = 'var(--green)' }: { label: string; value: any; color?: string }) {
  const width = typeof value === 'number' ? Math.max(2, Math.min(100, value * 100)) : 0;
  return <div className="probRow"><div className="probLabel"><span>{label}</span><b>{pct(value)}</b></div><div className="probTrack"><i style={{ width: `${width}%`, background: color }} /></div></div>;
}

function FactorCard({ number, title, leftLabel, rightLabel, left, right, note }: { number: string; title: string; leftLabel?: string; rightLabel?: string; left?: any; right?: any; note?: string }) {
  return <article className="factorCard">
    <div className="factorTitle"><span>{number}</span><b>{title}</b></div>
    {leftLabel || rightLabel ? <div className="factorValues"><div><small>{leftLabel || 'Équipe A'}</small><p>{left || 'Données indisponibles'}</p></div><div><small>{rightLabel || 'Équipe B'}</small><p>{right || 'Données indisponibles'}</p></div></div> : <p className="factorSingle">{left || 'Données indisponibles'}</p>}
    {note && <small className="factorNote">{note}</small>}
  </article>;
}

function formatRecent(label: string, freshness: any) {
  if (!freshness?.count) return `${label} : aucune rencontre dans la fenêtre récente.`;
  const last = freshness.latest ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(`${freshness.latest}T12:00:00`)) : 'date inconnue';
  return `${label} : ${freshness.count}/5 matchs, dernier le ${last}${typeof freshness.daysSinceLatest === 'number' ? ` (${freshness.daysSinceLatest} j avant le match)` : ''}.`;
}

function styleSummary(value: any) {
  if (!value) return 'Statistiques de style indisponibles via la source publique.';
  return `${value.possession}% possession · ${value.shotsOnTarget} tirs cadrés · ${value.shots} tirs · ${value.corners} corners · ${value.yellow} cartons`;
}

export default function Home() {
  const [leagues, setLeagues] = useState<League[]>([]);
  const [league, setLeague] = useState('eng.1');
  const [month, setMonth] = useState(() => todayKey().slice(0, 7));
  const [dayEvents, setDayEvents] = useState<DayEvents>({});
  const [selectedMatch, setSelectedMatch] = useState('');
  const [analysis, setAnalysis] = useState<any>(null);
  const [monthLoading, setMonthLoading] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [screening, setScreening] = useState(false);
  const [screenedScores, setScreenedScores] = useState<Record<string, any>>({});
  const [calendarError, setCalendarError] = useState('');
  const [analysisError, setAnalysisError] = useState('');
  const [tab, setTab] = useState<'resume' | 'facteurs' | 'vigilance'>('resume');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/leagues').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => setLeagues(d.leagues || [])).catch(() => setCalendarError('Impossible de charger les compétitions. Réessayez dans un instant.'));
  }, []);

  useEffect(() => {
    if (!league || !month) return;
    let active = true;
    const [year, monthNumber] = month.split('-').map(Number);
    const totalDays = new Date(year, monthNumber, 0).getDate();
    const keys = Array.from({ length: totalDays }, (_, i) => keyFor(year, monthNumber, i + 1));
    setMonthLoading(true);
    setCalendarError('');
    setDayEvents({});
    setSelectedMatch('');
    setAnalysis(null);
    setScreenedScores({});
    setSearch('');

    const load = async () => {
      const combined: DayEvents = {};
      let failures = 0;
      // ESPN fournit le tableau de scores par journée. Limiter la concurrence évite de surcharger son API publique.
      for (let i = 0; i < keys.length; i += 6) {
        const batch = keys.slice(i, i + 6);
        const results = await Promise.all(batch.map(async key => {
          try {
            const response = await fetch(`/api/fixtures?league=${encodeURIComponent(league)}&date=${key.replaceAll('-', '')}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            return [key, (payload.events || []) as Fixture[]] as const;
          } catch {
            failures += 1;
            return [key, [] as Fixture[]] as const;
          }
        }));
        if (!active) return;
        for (const [key, events] of results) combined[key] = events;
        setDayEvents({ ...combined });
      }
      if (!active) return;
      if (failures === keys.length) setCalendarError('Le calendrier est temporairement indisponible. Vérifiez votre connexion puis actualisez.');
      else if (failures > 0) setCalendarError(`Calendrier partiel : ${failures} journées n’ont pas pu être chargées.`);
      setMonthLoading(false);
    };
    load();
    return () => { active = false; };
  }, [league, month]);

  const monthFixtures = useMemo<MonthFixture[]>(() => {
    return Object.entries(dayEvents)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([dayKey, events]) => events.map(item => ({ ...item, dayKey })))
      .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || a.dayKey.localeCompare(b.dayKey));
  }, [dayEvents]);

  const fixture = useMemo(() => monthFixtures.find(item => item.id === selectedMatch), [monthFixtures, selectedMatch]);
  const visibleFixtures = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return monthFixtures;
    return monthFixtures.filter(item => `${item.home?.name || ''} ${item.away?.name || ''} ${item.venue || ''} ${shortDate(item.dayKey)}`.toLowerCase().includes(q));
  }, [monthFixtures, search]);

  useEffect(() => {
    if (!fixture) { setAnalysis(null); setAnalysisError(''); return; }
    let active = true;
    setAnalysisLoading(true);
    setAnalysis(null);
    setAnalysisError('');
    fetch(`/api/analyze?league=${encodeURIComponent(league)}&date=${fixture.dayKey.replaceAll('-', '')}&match=${encodeURIComponent(fixture.id)}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => {
        if (!active) return;
        const result = (d.matches || [])[0];
        if (result?.error) setAnalysisError(result.error);
        else setAnalysis(result || null);
      })
      .catch(() => active && setAnalysisError('Analyse momentanément indisponible. Réessayez.'))
      .finally(() => active && setAnalysisLoading(false));
    return () => { active = false; };
  }, [fixture?.id, fixture?.dayKey, league]);

  const datesWithMatches = Object.entries(dayEvents).filter(([, events]) => events.length > 0);
  const monthMatchCount = monthFixtures.length;
  const currentLeagueName = leagues.find(item => item.slug === league)?.name || league;

  const changeMonth = (delta: number) => {
    const d = new Date(`${month}-01T12:00:00`);
    d.setMonth(d.getMonth() + delta);
    setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };
  const selectFixture = (item: MonthFixture) => {
    setSelectedMatch(item.id);
    setTab('resume');
  };

  const scanMonth = async () => {
    const dayKeys = Array.from(new Set(visibleFixtures.map(item => item.dayKey)));
    if (!dayKeys.length) return;
    setScreening(true);
    try {
      const next: Record<string, any> = {};
      for (let i = 0; i < dayKeys.length; i += 4) {
        const batch = dayKeys.slice(i, i + 4);
        await Promise.all(batch.map(async dayKey => {
          const response = await fetch(`/api/analyze?league=${encodeURIComponent(league)}&date=${dayKey.replaceAll('-', '')}`);
          if (!response.ok) return;
          const payload = await response.json();
          (payload.matches || []).forEach((match: any) => { if (match.vigilance) next[match.id] = match.vigilance; });
        }));
        setScreenedScores(prev => ({ ...prev, ...next }));
      }
    } catch {
      setCalendarError('Le scan de vigilance n’a pas abouti. Réessayez.');
    } finally { setScreening(false); }
  };

  const probabilities = analysis?.probabilities || {};
  const factors = analysis?.factors || {};
  const vigilance = analysis?.vigilance || {};
  const freshHome = factors.forme?.fraicheurHome?.count ?? 0;
  const freshAway = factors.forme?.fraicheurAway?.count ?? 0;

  return <main className="appShell">
    <header className="appHeader">
      <a className="brand" href="#top" aria-label="Terrain, accueil"><span className="brandMark">T</span><span className="brandWords">TERRAIN<small>FOOTBALL INTELLIGENCE</small></span></a>
      <nav className="mainNav" aria-label="Navigation principale"><a className="navActive" href="#rencontres">Rencontres</a><a href="#analyse">Analyse</a></nav>
      <div className="dataStatus"><span className="statusPulse"/> API publique <i/> ESPN</div>
    </header>

    <section className="appHero" id="top">
      <div className="heroCopy">
        <div className="eyebrow"><span/> CENTRE DE MATCHS · SAISON EN COURS</div>
        <h1>Le calendrier,<br/><em>en un coup d’œil.</em></h1>
        <p>Choisissez une compétition, parcourez tous les matchs du mois sous forme de cartes, puis ouvrez une rencontre pour consulter son analyse complète.</p>
        <div className="heroStats"><span><b>08</b> facteurs examinés</span><span><b>16</b> compétitions</span><span className="estimateNote"><i/> estimations, jamais garanties</span></div>
      </div>
      <div className="heroPitch" aria-hidden="true"><div className="pitchCircle"/><div className="pitchLine"/><div className="pitchBall">⚽</div><span>DATA / 90</span></div>
    </section>

    <section className="toolbar" aria-label="Filtres du calendrier">
      <label className="selectField"><span className="fieldIcon">◈</span><span className="fieldCopy"><small>COMPÉTITION</small><select value={league} onChange={event => setLeague(event.target.value)}>{leagues.map(item => <option key={item.slug} value={item.slug}>{item.name} · {item.country}</option>)}</select></span></label>
      <div className="monthControl"><button className="iconButton" onClick={() => changeMonth(-1)} aria-label="Mois précédent">‹</button><div><small>CALENDRIER MENSUEL</small><strong>{monthLabel(month)}</strong></div><button className="iconButton" onClick={() => changeMonth(1)} aria-label="Mois suivant">›</button></div>
      <button className="todayButton" onClick={() => setMonth(todayKey().slice(0, 7))}><span>↻</span> Ce mois-ci</button>
      <div className="monthTotals"><b>{monthMatchCount}</b><span>matchs<br/>ce mois</span></div>
    </section>

    <section className="monthMatchesPanel" id="rencontres">
      <div className="sectionHeader monthMatchesHeader">
        <div>
          <span className="sectionKicker">{currentLeagueName.toUpperCase()} · {monthLabel(month).toUpperCase()}</span>
          <h2>Tous les matchs du mois</h2>
          <p>
            {calendarError ? <span className="inlineError">{calendarError}</span> : monthLoading
              ? <><i className="tinySpinner"/> Chargement des rencontres du mois…</>
              : <>{monthMatchCount} rencontre{monthMatchCount > 1 ? 's' : ''} sur {datesWithMatches.length} journée{datesWithMatches.length > 1 ? 's' : ''} · heures locales de Cotonou</>}
          </p>
        </div>
        <div className="monthMatchesActions">
          {monthFixtures.length > 0 && <>
            <label className="matchSearch monthSearch"><span>⌕</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Rechercher une équipe, un stade ou une date"/></label>
            <button className="scanButton monthScanButton" onClick={scanMonth} disabled={screening || monthLoading}>{screening ? <><i className="tinySpinner"/> Scan en cours…</> : <>⌕ &nbsp; Scanner les matchs</>}</button>
          </>}
          <span className="dayCount">{visibleFixtures.length} match{visibleFixtures.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {monthFixtures.length > 0 ? <>
        <div className="monthCardsGrid">
          {visibleFixtures.map((item, index) => {
            const score = screenedScores[item.id];
            const finished = Date.parse(item.date) <= Date.now() && item.home?.score !== null && item.away?.score !== null;
            return <a key={`${item.dayKey}-${item.id}`} href="#analyse" className={`matchCard monthMatchCard ${selectedMatch === item.id ? 'matchSelected' : ''}`} onClick={() => selectFixture(item)}>
              <span className="matchCardTop">
                <span className="matchOrdinal">{String(index + 1).padStart(2, '0')}</span>
                <span className="matchDatePill">{shortDate(item.dayKey)}</span>
                <span>{timeOf(item.date)} · COT</span>
                {score && <span className={`riskBadge ${score.score >= 30 ? 'riskHigh' : ''}`} title={`Signal exploratoire : ${score.level}`}>Vigilance {score.score}</span>}
              </span>
              <span className="matchTeams">
                <span><TeamBadge team={item.home} size={34}/><b>{item.home?.name}</b>{finished && <strong>{item.home?.score}</strong>}</span>
                <span><TeamBadge team={item.away} size={34}/><b>{item.away?.name}</b>{finished && <strong>{item.away?.score}</strong>}</span>
              </span>
              <span className="matchCardFoot">
                <span>{item.venue || 'Lieu non renseigné'}</span>
                <span className="openArrow">{selectedMatch === item.id ? 'OUVERTE' : 'VOIR L’ANALYSE'} <b>→</b></span>
              </span>
            </a>;
          })}
        </div>
        {visibleFixtures.length === 0 && <div className="emptyState">Aucune rencontre ne correspond à « {search} ».</div>}
        <p className="panelDisclaimer">Les scores de vigilance sont des signaux exploratoires, pas des preuves de manipulation.</p>
      </> : monthLoading ? (
        <div className="emptyState"><i className="largeSpinner"/><b>Chargement des matchs du mois</b><span>Récupération des rencontres de {currentLeagueName} pour {monthLabel(month)}…</span></div>
      ) : (
        <div className="emptyState"><span className="emptyIcon">⚽</span><b>Aucun match programmé ce mois-ci</b><span>Changez de mois ou sélectionnez une autre compétition pour afficher ses rencontres.</span></div>
      )}
    </section>

    <section className="analysisSection">
      <section className="analysisPanel" id="analyse">
        {fixture ? <>
          <div className="analysisTopline"><div><span className="sectionKicker">{currentLeagueName}</span><h2>Analyse de la rencontre</h2></div><span className="estimatePill">ESTIMATION · NON GARANTIE</span></div>
          <div className="matchHero">
            <div className="analysisMatchMeta"><span>{longDate(fixture.dayKey)}</span><span>·</span><span>{timeOf(fixture.date)} COT</span>{fixture.venue && <><span>·</span><span>{fixture.venue}</span></>}</div>
            <div className="scoreboard"><div><TeamBadge team={fixture.home} size={56}/><b>{fixture.home?.name}</b><small>DOMICILE</small></div><span className="vsToken">VS</span><div><TeamBadge team={fixture.away} size={56}/><b>{fixture.away?.name}</b><small>EXTÉRIEUR</small></div></div>
            {analysis && <div className="xgSummary"><span>xG ESTIMÉS</span><b>{analysis.expectedGoals?.home}</b><i>—</i><b>{analysis.expectedGoals?.away}</b></div>}
          </div>
          <div className="analysisTabs">{([['resume', 'Vue d’ensemble'], ['facteurs', '8 facteurs'], ['vigilance', 'Vigilance']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'tabActive' : ''} onClick={() => setTab(id)}>{label}{id === 'vigilance' && <i/>}</button>)}</div>
          {analysisLoading && <div className="analysisLoading"><i className="largeSpinner"/><div><b>Analyse en cours</b><span>Forme, calendrier, statistiques et disponibilité ESPN…</span></div></div>}
          {!analysisLoading && analysisError && <div className="analysisError">{analysisError}</div>}
          {!analysisLoading && analysis && tab === 'resume' && <>
            <div className="predictionIntro"><div><span className="sectionKicker">MODÈLE STATISTIQUE</span><h3>Estimations du match</h3><small>Forme récente : {freshHome}/5 & {freshAway}/5 matchs, sur 60 jours max.</small></div><span className="modelMark">Poisson</span></div>
            {(freshHome < 5 || freshAway < 5) && <div className="dataWarning">Échantillon récent incomplet. Les données plus anciennes sont exclues ; la confiance dans l’estimation est donc plus limitée.</div>}
            <div className="predictionGrid">
              <article className="predictionCard"><div className="cardHeading"><span>1X2</span><div><b>Résultat final</b><small>Temps réglementaire</small></div></div><ProbBar label={`Victoire · ${fixture.home?.short || 'domicile'}`} value={probabilities.home}/><ProbBar label="Match nul" value={probabilities.draw} color="var(--gold)"/><ProbBar label={`Victoire · ${fixture.away?.short || 'extérieur'}`} value={probabilities.away} color="var(--blue)"/></article>
              <article className="predictionCard"><div className="cardHeading"><span>↗</span><div><b>Les deux équipes marquent</b><small>BTTS · match entier</small></div></div><div className="bttsGrid"><div><small>OUI</small><b>{pct(probabilities.bttsYes)}</b><i style={{ width: `${(probabilities.bttsYes || 0) * 100}%` }}/></div><div><small>NON</small><b>{pct(probabilities.bttsNo)}</b><i style={{ width: `${(probabilities.bttsNo || 0) * 100}%` }}/></div></div></article>
              <article className="predictionCard"><div className="cardHeading"><span>Σ</span><div><b>Total de buts</b><small>Plus / moins · match entier</small></div></div><div className="totalsTable"><div><span>SEUIL</span><span>PLUS</span><span>MOINS</span></div>{[['1,5', probabilities.over15, probabilities.under15], ['2,5', probabilities.over25, probabilities.under25]].map(row => <div key={row[0]}><b>{row[0]}</b><strong>{pct(row[1])}</strong><strong>{pct(row[2])}</strong></div>)}</div></article>
              <article className="predictionCard"><div className="cardHeading"><span>⌗</span><div><b>Scores les plus probables</b><small>Estimations du modèle</small></div></div><div className="scoreChips">{(analysis.topScores || []).slice(0, 5).map((score: any) => <span key={`${score.h}-${score.a}`}><b>{score.h}–{score.a}</b><small>{pct(score.p)}</small></span>)}</div></article>
              <article className="predictionCard fullPrediction"><div className="cardHeading"><span>½</span><div><b>Buts par période</b><small>Probabilités par mi-temps</small></div></div><div className="halfTable"><div><span>PÉRIODE</span><span>SEUIL</span><span>PLUS</span><span>MOINS</span></div>{[['1re mi-temps', '1,5', probabilities.firstHalf?.over15], ['1re mi-temps', '2,5', probabilities.firstHalf?.over25], ['2e mi-temps', '1,5', probabilities.secondHalf?.over15], ['2e mi-temps', '2,5', probabilities.secondHalf?.over25]].map((row, index) => <div key={index}><span>{row[0]}</span><b>{row[1]}</b><strong>{pct(row[2])}</strong><strong>{pct(typeof row[2] === 'number' ? 1 - row[2] : undefined)}</strong></div>)}</div><small className="tableNote">Estimations par période, indépendantes du score à la pause.</small></article>
            </div>
            <div className={`vigilanceSummary ${vigilance.score >= 30 ? 'vigilanceWarn' : ''}`}><span className="vigilanceIcon">!</span><div><b>Vigilance · {vigilance.level || '—'} <small>{vigilance.score ?? '—'}/100</small></b><p>{vigilance.reasons?.[0] || 'Aucun signal majeur détecté avec les données disponibles.'}</p></div><button onClick={() => setTab('vigilance')}>Détails <span>→</span></button></div>
            <p className="legalNote">Les probabilités sont des estimations fondées sur des données publiques. Elles ne constituent ni conseil de pari ni garantie de résultat.</p>
          </>}
          {!analysisLoading && analysis && tab === 'facteurs' && <div className="factorArea"><div className="subsectionHeading"><span className="sectionKicker">MÉTHODE RAPIDE EN 5 MINUTES</span><h3>Les 8 facteurs pris en compte</h3><p>Chaque information indisponible via l’API publique est signalée au lieu d’être inventée.</p></div><div className="factorGrid">
            <FactorCard number="01" title="Forme récente · 5 matchs max" leftLabel={fixture.home?.name} rightLabel={fixture.away?.name} left={factors.forme?.home} right={factors.forme?.away} note={`${factors.forme?.note || ''} ${formatRecent('Domicile', factors.forme?.fraicheurHome)} ${formatRecent('Extérieur', factors.forme?.fraicheurAway)}`}/>
            <FactorCard number="02" title="Domicile / extérieur" leftLabel="À domicile" rightLabel="À l’extérieur" left={factors.domicileExterieur?.home} right={factors.domicileExterieur?.away}/>
            <FactorCard number="03" title="Confrontations directes" left={factors.h2h?.resume} note={factors.h2h?.note}/>
            <FactorCard number="04" title="Blessés / suspendus" leftLabel={fixture.home?.short} rightLabel={fixture.away?.short} left={factors.blessures?.home} right={factors.blessures?.away} note={factors.blessures?.note}/>
            <FactorCard number="05" title="Enjeu & classement" leftLabel={fixture.home?.short} rightLabel={fixture.away?.short} left={factors.enjeu?.home} right={factors.enjeu?.away}/>
            <FactorCard number="06" title="Style de jeu récent" leftLabel={fixture.home?.short} rightLabel={fixture.away?.short} left={styleSummary(factors.style?.home)} right={styleSummary(factors.style?.away)} note="Moyennes des derniers matchs disponibles : possession, tirs, tirs cadrés, corners et cartons."/>
            <FactorCard number="07" title="Statistiques attaque / défense" leftLabel={fixture.home?.short} rightLabel={fixture.away?.short} left={factors.stats?.home ? `Attaque ${factors.stats.home.attaque} · défense concède ${factors.stats.home.defense} buts/match` : ''} right={factors.stats?.away ? `Attaque ${factors.stats.away.attaque} · défense concède ${factors.stats.away.defense} buts/match` : ''} note={factors.stats?.note}/>
            <FactorCard number="08" title="Météo, repos & autres" leftLabel={fixture.home?.short} rightLabel={fixture.away?.short} left={`${factors.autres?.reposHome ?? '—'} jours de repos`} right={`${factors.autres?.reposAway ?? '—'} jours de repos`} note={`${factors.autres?.meteo ? `Météo : ${factors.autres.meteo.description || 'données disponibles'}. ` : 'Météo non disponible. '}${factors.autres?.note || ''}`}/>
          </div><div className="fiveMinuteNote"><b>Lecture rapide</b><span>Comparer les facteurs disponibles, repérer les données manquantes et garder en tête que la sortie reste une estimation du modèle, pas une certitude.</span></div></div>}
          {!analysisLoading && analysis && tab === 'vigilance' && <div className="vigilancePage"><div className={`vigilanceScore ${vigilance.score >= 30 ? 'vigilanceWarn' : ''}`}><span>INDICE EXPLORATOIRE</span><b>{vigilance.score ?? '—'}<small>/100</small></b><strong>{vigilance.level || '—'}</strong><p>Ce signal n’est ni une accusation ni une preuve de manipulation.</p></div><div className="vigilanceDetails"><span className="sectionKicker">ÉLÉMENTS DE CONTEXTE</span><h3>Pourquoi ce niveau ?</h3>{(vigilance.reasons || []).map((reason: string, index: number) => <div className="reasonRow" key={index}><span>{String(index + 1).padStart(2, '0')}</span><p>{reason}</p></div>)}{(!vigilance.reasons || !vigilance.reasons.length) && <p className="factorSingle">Aucun élément de vigilance particulier n’a été retourné.</p>}<div className="integrityNotice"><b>À retenir</b><p>Un score élevé peut refléter une information manquante ou une faiblesse du modèle. Seules les autorités et les organismes d’intégrité peuvent enquêter.</p></div></div></div>}
        </> : <div className="analysisPlaceholder"><div className="placeholderIcon">◉</div><b>{selectedMatch ? 'Préparation de l’analyse' : 'Ouvrez une rencontre'}</b><p>{selectedMatch ? 'Les statistiques et les estimations apparaîtront ici.' : 'Sélectionnez une carte de match ci-dessus pour voir les estimations, les 8 facteurs et le niveau de vigilance.'}</p></div>}
      </section>
    </section>

    <footer className="appFooter"><span>© TERRAIN · FOOTBALL INTELLIGENCE</span><span>DONNÉES PUBLIQUES ESPN · ESTIMATIONS, JAMAIS DES CERTITUDES</span></footer>
  </main>;
}
