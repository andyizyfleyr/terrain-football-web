'use client';

import { useEffect, useState } from 'react';
import { Fixture, isFixtureFinished, longDate, pct, Team, timeOf } from '../lib/terrain';

export function TeamBadge({ team, size = 36 }: { team?: Team; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [team?.id, team?.logo]);
  const logo = team?.logo || (team?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${team.id}.png` : '');
  return (
    <span className="teamBadge" style={{ width: size, height: size }}>
      {logo && !broken ? (
        <img src={logo} alt={`${team?.name || 'Équipe'} — logo`} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span>{(team?.short || team?.name || '?').slice(0, 3)}</span>
      )}
    </span>
  );
}

function ProbBar({ label, value, color = 'var(--green)' }: { label: string; value: any; color?: string }) {
  const width = typeof value === 'number' ? Math.max(2, Math.min(100, value * 100)) : 0;
  return (
    <div className="probRow">
      <div className="probLabel">
        <span>{label}</span>
        <b>{pct(value)}</b>
      </div>
      <div className="probTrack">
        <i style={{ width: `${width}%`, background: color }} />
      </div>
    </div>
  );
}

function FactorCard({
  number,
  title,
  leftLabel,
  rightLabel,
  left,
  right,
  note,
}: {
  number: string;
  title: string;
  leftLabel?: string;
  rightLabel?: string;
  left?: any;
  right?: any;
  note?: string;
}) {
  return (
    <article className="factorCard">
      <div className="factorTitle">
        <span>{number}</span>
        <b>{title}</b>
      </div>
      {leftLabel || rightLabel ? (
        <div className="factorValues">
          <div>
            <small>{leftLabel || 'Équipe A'}</small>
            <p>{left || 'Données indisponibles'}</p>
          </div>
          <div>
            <small>{rightLabel || 'Équipe B'}</small>
            <p>{right || 'Données indisponibles'}</p>
          </div>
        </div>
      ) : (
        <p className="factorSingle">{left || 'Données indisponibles'}</p>
      )}
      {note && <small className="factorNote">{note}</small>}
    </article>
  );
}

function formatRecent(label: string, freshness: any) {
  if (!freshness?.count) return `${label} : aucune rencontre dans la fenêtre récente.`;
  const last = freshness.latest
    ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(`${freshness.latest}T12:00:00`))
    : 'date inconnue';
  return `${label} : ${freshness.count}/5 matchs, dernier le ${last}${
    typeof freshness.daysSinceLatest === 'number' ? ` (${freshness.daysSinceLatest} j avant le match)` : ''
  }.`;
}

function styleSummary(value: any) {
  if (!value) return 'Statistiques de style indisponibles via la source publique.';
  return `${value.possession}% possession · ${value.shotsOnTarget} tirs cadrés · ${value.shots} tirs · ${value.corners} corners · ${value.yellow} cartons`;
}

type MatchAnalysisPanelProps = {
  leagueSlug: string;
  leagueName?: string;
  dayKey: string;
  matchId: string;
  initialFixture?: Fixture | null;
  onClose?: () => void;
  closeLabel?: string;
};

export function MatchAnalysisPanel({
  leagueSlug,
  leagueName,
  dayKey,
  matchId,
  initialFixture = null,
  onClose,
  closeLabel = 'Retour aux rencontres',
}: MatchAnalysisPanelProps) {
  const [fixture, setFixture] = useState<Fixture | null>(initialFixture);
  const [fixtureLoading, setFixtureLoading] = useState(!initialFixture);
  const [analysis, setAnalysis] = useState<any>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisError, setAnalysisError] = useState('');
  const [tab, setTab] = useState<'resume' | 'facteurs' | 'vigilance'>('resume');

  useEffect(() => {
    if (initialFixture) {
      setFixture(initialFixture);
      setFixtureLoading(false);
    }
  }, [initialFixture]);

  useEffect(() => {
    let active = true;
    const compactDate = dayKey.replaceAll('-', '');

    if (!initialFixture) {
      setFixtureLoading(true);
      fetch(`/api/fixtures?league=${encodeURIComponent(leagueSlug)}&date=${encodeURIComponent(compactDate)}`)
        .then(r => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then(d => {
          if (!active) return;
          const found = ((d.events || []) as Fixture[]).find(ev => String(ev.id) === String(matchId)) || null;
          setFixture(found);
        })
        .catch(() => {
          // On laissera l'analyse tenter de fournir des infos si possible
        })
        .finally(() => active && setFixtureLoading(false));
    }

    setAnalysisLoading(true);
    setAnalysis(null);
    setAnalysisError('');
    setTab('resume');

    fetch(
      `/api/analyze?league=${encodeURIComponent(leagueSlug)}&date=${encodeURIComponent(compactDate)}&match=${encodeURIComponent(matchId)}`
    )
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(d => {
        if (!active) return;
        const result = (d.matches || [])[0];
        if (result?.error) setAnalysisError(result.error);
        else {
          setAnalysis(result || null);
          if (!initialFixture && result?.home && result?.away) {
            setFixture(prev =>
              prev || {
                id: String(result.id || matchId),
                date: result.date || `${dayKey}T12:00:00Z`,
                name: `${result.home?.name || ''} - ${result.away?.name || ''}`,
                home: result.home,
                away: result.away,
                venue: result.venue,
              }
            );
          }
        }
      })
      .catch(() => active && setAnalysisError('Analyse momentanément indisponible. Réessayez.'))
      .finally(() => active && setAnalysisLoading(false));

    return () => {
      active = false;
    };
  }, [leagueSlug, dayKey, matchId, initialFixture]);

  const probabilities = analysis?.probabilities || {};
  const factors = analysis?.factors || {};
  const vigilance = analysis?.vigilance || {};
  const freshHome = factors.forme?.fraicheurHome?.count ?? 0;
  const freshAway = factors.forme?.fraicheurAway?.count ?? 0;
  const finished = fixture ? isFixtureFinished(fixture) : false;

  return (
    <section className="analysisPanel" id="analyse">
      <div className="analysisTopline">
        <div className="analysisToplineLeft">
          {onClose && (
            <button type="button" className="backLinkButton" onClick={onClose}>
              <span>←</span> {closeLabel}
            </button>
          )}
          <div>
            <span className="sectionKicker">{leagueName || leagueSlug.toUpperCase()}</span>
            <h2>Analyse de la rencontre</h2>
          </div>
        </div>
        <span className="estimatePill">ESTIMATION · NON GARANTIE</span>
      </div>

      {fixture ? (
        <>
          <div className="matchHero">
            <div className="analysisMatchMeta">
              <span>{longDate(dayKey)}</span>
              <span>·</span>
              <span>{timeOf(fixture.date)} COT</span>
              {fixture.venue && (
                <>
                  <span>·</span>
                  <span>{fixture.venue}</span>
                </>
              )}
              <span className={`matchStatusPill ${finished ? 'statusDone' : 'statusUpcoming'}`}>
                {finished ? 'Terminé' : 'À venir'}
              </span>
            </div>
            <div className="scoreboard">
              <div>
                <TeamBadge team={fixture.home} size={56} />
                <b>{fixture.home?.name}</b>
                <small>DOMICILE</small>
              </div>
              {finished ? (
                <div className="finalScoreBox">
                  <strong>
                    {fixture.home?.score} <i>–</i> {fixture.away?.score}
                  </strong>
                  <small>SCORE FINAL</small>
                </div>
              ) : (
                <span className="vsToken">VS</span>
              )}
              <div>
                <TeamBadge team={fixture.away} size={56} />
                <b>{fixture.away?.name}</b>
                <small>EXTÉRIEUR</small>
              </div>
            </div>
            {analysis && (
              <div className="xgSummary">
                <span>xG ESTIMÉS</span>
                <b>{analysis.expectedGoals?.home}</b>
                <i>—</i>
                <b>{analysis.expectedGoals?.away}</b>
              </div>
            )}
          </div>

          <div className="analysisTabs">
            {([
              ['resume', 'Vue d’ensemble'],
              ['facteurs', '8 facteurs'],
              ['vigilance', 'Vigilance'],
            ] as const).map(([id, label]) => (
              <button key={id} className={tab === id ? 'tabActive' : ''} onClick={() => setTab(id)}>
                {label}
                {id === 'vigilance' && <i />}
              </button>
            ))}
          </div>

          {analysisLoading && (
            <div className="analysisLoading">
              <i className="largeSpinner" />
              <div>
                <b>Analyse en cours</b>
                <span>Forme, calendrier, statistiques et disponibilité ESPN…</span>
              </div>
            </div>
          )}

          {!analysisLoading && analysisError && <div className="analysisError">{analysisError}</div>}

          {!analysisLoading && analysis && tab === 'resume' && (
            <>
              <div className="predictionIntro">
                <div>
                  <span className="sectionKicker">MODÈLE STATISTIQUE</span>
                  <h3>Estimations du match</h3>
                  <small>
                    Forme récente : {freshHome}/5 & {freshAway}/5 matchs, sur 60 jours max.
                  </small>
                </div>
                <span className="modelMark">Poisson</span>
              </div>
              {(freshHome < 5 || freshAway < 5) && (
                <div className="dataWarning">
                  Échantillon récent incomplet. Les données plus anciennes sont exclues ; la confiance dans l’estimation est donc plus
                  limitée.
                </div>
              )}
              <div className="predictionGrid">
                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>1X2</span>
                    <div>
                      <b>Résultat final</b>
                      <small>Temps réglementaire</small>
                    </div>
                  </div>
                  <ProbBar label={`Victoire · ${fixture.home?.short || 'domicile'}`} value={probabilities.home} />
                  <ProbBar label="Match nul" value={probabilities.draw} color="var(--gold)" />
                  <ProbBar label={`Victoire · ${fixture.away?.short || 'extérieur'}`} value={probabilities.away} color="var(--blue)" />
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>↗</span>
                    <div>
                      <b>Les deux équipes marquent</b>
                      <small>BTTS · match entier</small>
                    </div>
                  </div>
                  <div className="bttsGrid">
                    <div>
                      <small>OUI</small>
                      <b>{pct(probabilities.bttsYes)}</b>
                      <i style={{ width: `${(probabilities.bttsYes || 0) * 100}%` }} />
                    </div>
                    <div>
                      <small>NON</small>
                      <b>{pct(probabilities.bttsNo)}</b>
                      <i style={{ width: `${(probabilities.bttsNo || 0) * 100}%` }} />
                    </div>
                  </div>
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>Σ</span>
                    <div>
                      <b>Total de buts</b>
                      <small>Plus / moins · match entier</small>
                    </div>
                  </div>
                  <div className="totalsTable">
                    <div>
                      <span>SEUIL</span>
                      <span>PLUS</span>
                      <span>MOINS</span>
                    </div>
                    {[
                      ['1,5', probabilities.over15, probabilities.under15],
                      ['2,5', probabilities.over25, probabilities.under25],
                    ].map(row => (
                      <div key={row[0]}>
                        <b>{row[0]}</b>
                        <strong>{pct(row[1])}</strong>
                        <strong>{pct(row[2])}</strong>
                      </div>
                    ))}
                  </div>
                </article>

                <article className="predictionCard">
                  <div className="cardHeading">
                    <span>⌗</span>
                    <div>
                      <b>Scores les plus probables</b>
                      <small>Estimations du modèle</small>
                    </div>
                  </div>
                  <div className="scoreChips">
                    {(analysis.topScores || []).slice(0, 5).map((score: any) => (
                      <span key={`${score.h}-${score.a}`}>
                        <b>
                          {score.h}–{score.a}
                        </b>
                        <small>{pct(score.p)}</small>
                      </span>
                    ))}
                  </div>
                </article>

                <article className="predictionCard fullPrediction">
                  <div className="cardHeading">
                    <span>½</span>
                    <div>
                      <b>Buts par période</b>
                      <small>Probabilités par mi-temps</small>
                    </div>
                  </div>
                  <div className="halfTable">
                    <div>
                      <span>PÉRIODE</span>
                      <span>SEUIL</span>
                      <span>PLUS</span>
                      <span>MOINS</span>
                    </div>
                    {[
                      ['1re mi-temps', '1,5', probabilities.firstHalf?.over15],
                      ['1re mi-temps', '2,5', probabilities.firstHalf?.over25],
                      ['2e mi-temps', '1,5', probabilities.secondHalf?.over15],
                      ['2e mi-temps', '2,5', probabilities.secondHalf?.over25],
                    ].map((row, index) => (
                      <div key={index}>
                        <span>{row[0]}</span>
                        <b>{row[1]}</b>
                        <strong>{pct(row[2])}</strong>
                        <strong>{pct(typeof row[2] === 'number' ? 1 - row[2] : undefined)}</strong>
                      </div>
                    ))}
                  </div>
                  <small className="tableNote">Estimations par période, indépendantes du score à la pause.</small>
                </article>
              </div>

              <div className={`vigilanceSummary ${vigilance.score >= 30 ? 'vigilanceWarn' : ''}`}>
                <span className="vigilanceIcon">!</span>
                <div>
                  <b>
                    Vigilance · {vigilance.level || '—'} <small>{vigilance.score ?? '—'}/100</small>
                  </b>
                  <p>{vigilance.reasons?.[0] || 'Aucun signal majeur détecté avec les données disponibles.'}</p>
                </div>
                <button onClick={() => setTab('vigilance')}>
                  Détails <span>→</span>
                </button>
              </div>
              <p className="legalNote">
                Les probabilités sont des estimations fondées sur des données publiques. Elles ne constituent ni conseil de pari ni
                garantie de résultat.
              </p>
            </>
          )}

          {!analysisLoading && analysis && tab === 'facteurs' && (
            <div className="factorArea">
              <div className="subsectionHeading">
                <span className="sectionKicker">MÉTHODE RAPIDE EN 5 MINUTES</span>
                <h3>Les 8 facteurs pris en compte</h3>
                <p>Chaque information indisponible via l’API publique est signalée au lieu d’être inventée.</p>
              </div>
              <div className="factorGrid">
                <FactorCard
                  number="01"
                  title="Forme récente · 5 matchs max"
                  leftLabel={fixture.home?.name}
                  rightLabel={fixture.away?.name}
                  left={factors.forme?.home}
                  right={factors.forme?.away}
                  note={`${factors.forme?.note || ''} ${formatRecent('Domicile', factors.forme?.fraicheurHome)} ${formatRecent(
                    'Extérieur',
                    factors.forme?.fraicheurAway
                  )}`}
                />
                <FactorCard
                  number="02"
                  title="Domicile / extérieur"
                  leftLabel="À domicile"
                  rightLabel="À l’extérieur"
                  left={factors.domicileExterieur?.home}
                  right={factors.domicileExterieur?.away}
                />
                <FactorCard number="03" title="Confrontations directes" left={factors.h2h?.resume} note={factors.h2h?.note} />
                <FactorCard
                  number="04"
                  title="Blessés / suspendus"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={factors.blessures?.home}
                  right={factors.blessures?.away}
                  note={factors.blessures?.note}
                />
                <FactorCard
                  number="05"
                  title="Enjeu & classement"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={factors.enjeu?.home}
                  right={factors.enjeu?.away}
                />
                <FactorCard
                  number="06"
                  title="Style de jeu récent"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={styleSummary(factors.style?.home)}
                  right={styleSummary(factors.style?.away)}
                  note="Moyennes des derniers matchs disponibles : possession, tirs, tirs cadrés, corners et cartons."
                />
                <FactorCard
                  number="07"
                  title="Statistiques attaque / défense"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={
                    factors.stats?.home
                      ? `Attaque ${factors.stats.home.attaque} · défense concède ${factors.stats.home.defense} buts/match`
                      : ''
                  }
                  right={
                    factors.stats?.away
                      ? `Attaque ${factors.stats.away.attaque} · défense concède ${factors.stats.away.defense} buts/match`
                      : ''
                  }
                  note={factors.stats?.note}
                />
                <FactorCard
                  number="08"
                  title="Météo, repos & autres"
                  leftLabel={fixture.home?.short}
                  rightLabel={fixture.away?.short}
                  left={`${factors.autres?.reposHome ?? '—'} jours de repos`}
                  right={`${factors.autres?.reposAway ?? '—'} jours de repos`}
                  note={`${
                    factors.autres?.meteo ? `Météo : ${factors.autres.meteo.description || 'données disponibles'}. ` : 'Météo non disponible. '
                  }${factors.autres?.note || ''}`}
                />
              </div>
              <div className="fiveMinuteNote">
                <b>Lecture rapide</b>
                <span>
                  Comparer les facteurs disponibles, repérer les données manquantes et garder en tête que la sortie reste une estimation
                  du modèle, pas une certitude.
                </span>
              </div>
            </div>
          )}

          {!analysisLoading && analysis && tab === 'vigilance' && (
            <div className="vigilancePage">
              <div className={`vigilanceScore ${vigilance.score >= 30 ? 'vigilanceWarn' : ''}`}>
                <span>INDICE EXPLORATOIRE</span>
                <b>
                  {vigilance.score ?? '—'}
                  <small>/100</small>
                </b>
                <strong>{vigilance.level || '—'}</strong>
                <p>Ce signal n’est ni une accusation ni une preuve de manipulation.</p>
              </div>
              <div className="vigilanceDetails">
                <span className="sectionKicker">ÉLÉMENTS DE CONTEXTE</span>
                <h3>Pourquoi ce niveau ?</h3>
                {(vigilance.reasons || []).map((reason: string, index: number) => (
                  <div className="reasonRow" key={index}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <p>{reason}</p>
                  </div>
                ))}
                {(!vigilance.reasons || !vigilance.reasons.length) && (
                  <p className="factorSingle">Aucun élément de vigilance particulier n’a été retourné.</p>
                )}
                <div className="integrityNotice">
                  <b>À retenir</b>
                  <p>
                    Un score élevé peut refléter une information manquante ou une faiblesse du modèle. Seules les autorités et les
                    organismes d’intégrité peuvent enquêter.
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      ) : fixtureLoading || analysisLoading ? (
        <div className="analysisLoading">
          <i className="largeSpinner" />
          <div>
            <b>Chargement de la rencontre…</b>
            <span>Récupération des informations et de l’analyse ESPN…</span>
          </div>
        </div>
      ) : (
        <div className="analysisPlaceholder">
          <div className="placeholderIcon">◉</div>
          <b>Rencontre introuvable</b>
          <p>Cette rencontre n’a pas pu être chargée ou n’est plus disponible pour cette journée.</p>
        </div>
      )}
    </section>
  );
}
