'use client';

import { Fixture } from '../lib/terrain';
import { TeamBadge } from './TeamBadge';
import { pronosticsMarketCount } from './PronosticsPanel';

const pct = (value: any) => (typeof value === 'number' ? `${Math.round(value * 100)} %` : '—');
const num = (value: any, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits).replace('.', ',') : '—';

/**
 * SYNTHÈSE DE LA RENCONTRE
 *
 * L'onglet d'ouverture doit répondre en un écran : qui est favori, à quel
 * point, sur quels chiffres et ce qui peut contredire le modèle. Tout le
 * détail chiffré (1X2 complet, BTTS, totaux, scores exacts, périodes)
 * vit dans l'onglet « Pronostics » : rien n'est répété ici.
 */
export function MatchOverview({
  analysis,
  analyst,
  fixture,
  onOpenTab,
}: {
  analysis: any;
  analyst: any;
  fixture: Fixture;
  onOpenTab: (tab: 'pronostics' | 'analyste' | 'facteurs' | 'vigilance') => void;
}) {
  const probabilities = analysis?.probabilities || {};
  const vigilance = analysis?.vigilance || {};
  const factors = analysis?.factors || {};
  const confidence = analyst?.confidence || {};
  const synthesis = analyst?.synthesis || {};
  const market = analyst?.market || {};
  const traps: any[] = Array.isArray(analyst?.traps) ? analyst.traps : [];
  const insights: string[] = Array.isArray(analysis?.fotmob?.insights) ? analysis.fotmob.insights.slice(0, 3) : [];
  const lambdaHome = analyst?.lambdas?.home;
  const lambdaAway = analyst?.lambdas?.away;
  const expectedTotal =
    typeof lambdaHome === 'number' && typeof lambdaAway === 'number' ? lambdaHome + lambdaAway : null;
  const marketCount = analyst?.pronostics ? pronosticsMarketCount(analyst.pronostics) : 0;
  const homeAbsences: any[] = Array.isArray(factors.blessures?.homePlayers) ? factors.blessures.homePlayers : [];
  const awayAbsences: any[] = Array.isArray(factors.blessures?.awayPlayers) ? factors.blessures.awayPlayers : [];
  const absenceCount = homeAbsences.length + awayAbsences.length;

  const home = probabilities.home;
  const draw = probabilities.draw;
  const away = probabilities.away;
  const hasOutcome = [home, draw, away].every((v: any) => typeof v === 'number' && Number.isFinite(v));

  const hasScore = typeof confidence.score === 'number';
  const warningTraps = traps.filter(t => t?.severity === 'warning');

  return (
    <div className="matchOverview">
      {/* ---------------- Verdict ---------------- */}
      <section className="verdictCard" aria-label="Verdict de l’analyste">
        <div className="verdictTop">
          <div className="verdictScore">
            <span>SCORE ANALYSTE</span>
            <b>
              {hasScore ? confidence.score : '—'}
              <small>/100</small>
            </b>
            <em>{confidence.label || '—'}</em>
          </div>
          <div className="verdictCopy">
            <span className="sectionKicker">SYNTHÈSE DE L’ANALYSTE IA</span>
            <h3>{synthesis.headline || 'Analyse en cours de consolidation.'}</h3>
            {synthesis.text ? <p>{synthesis.text}</p> : null}
            {Array.isArray(synthesis.bullets) && synthesis.bullets.length > 0 ? (
              <ul className="verdictBullets">
                {synthesis.bullets.slice(0, 3).map((line: string, i: number) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
        {hasOutcome ? (
          <div className="verdictOutcome">
            <div className="outcomeBar" role="img" aria-label={`Issue du match : ${fixture.home?.short} ${pct(home)}, nul ${pct(draw)}, ${fixture.away?.short} ${pct(away)}`}>
              <i className="outcomeHome" style={{ width: `${home * 100}%` }} />
              <i className="outcomeDraw" style={{ width: `${draw * 100}%` }} />
              <i className="outcomeAway" style={{ width: `${away * 100}%` }} />
            </div>
            <div className="outcomeLegend">
              <span className="outcomeLegendHome">
                <b>{fixture.home?.short || 'Dom.'}</b>
                <em>{pct(home)}</em>
              </span>
              <span className="outcomeLegendDraw">
                <b>Nul</b>
                <em>{pct(draw)}</em>
              </span>
              <span className="outcomeLegendAway">
                <b>{fixture.away?.short || 'Ext.'}</b>
                <em>{pct(away)}</em>
              </span>
            </div>
          </div>
        ) : null}
        <button type="button" className="verdictCta" onClick={() => onOpenTab('analyste')}>
          Lire le rapport complet <span aria-hidden="true">→</span>
        </button>
      </section>

      {/* ---------------- Chiffres clés ---------------- */}
      <section className="keyFigures" aria-label="Chiffres clés">
        <div className="keyFigure">
          <span>xG MODÈLE</span>
          <b>
            {num(analysis?.expectedGoals?.home)} <i>–</i> {num(analysis?.expectedGoals?.away)}
          </b>
          <small>{analyst?.lambdas ? `λ ${num(analyst.lambdas.home)} / ${num(analyst.lambdas.away)}` : 'buts attendus'}</small>
        </div>
        <div className="keyFigure">
          <span>TOTAL DE BUTS ATTENDU</span>
          <b>{expectedTotal !== null ? num(expectedTotal) : '—'}</b>
          <small>{expectedTotal !== null ? 'aucun score exact prédit' : 'estimation'}</small>
        </div>
        <div className="keyFigure">
          <span>PLUS DE 2,5 BUTS</span>
          <b>{pct(probabilities.over25)}</b>
          <small>moins de 2,5 : {pct(probabilities.under25)}</small>
        </div>
        <div className="keyFigure">
          <span>LES DEUX MARQUENT</span>
          <b>{pct(probabilities.bttsYes)}</b>
          <small>une équipe muette : {pct(probabilities.bttsNo)}</small>
        </div>
      </section>

      {typeof confidence.probability === 'number' ? (
        <p className="confidenceNote">
          Probabilité mesurée <b>{pct(confidence.probability)}</b>
          {confidence.interval ? ` (intervalle ${pct(confidence.interval.low)} – ${pct(confidence.interval.high)})` : ''} ·{' '}
          {market.available
            ? `calibrée avec le marché ${market.oddsProvider || ''} (poids modèle ${Math.round((market.weights?.model ?? 0) * 100)} %)`
            : 'modèle seul, marché indisponible'}
          .
        </p>
      ) : null}

      {/* ---------------- Signaux ---------------- */}
      {warningTraps.length > 0 || (typeof vigilance.score === 'number' && vigilance.score >= 30) || absenceCount > 0 ? (
        <section className="overviewSignals" aria-label="Points de vigilance">
          <div className="overviewSectionHead">
            <span className="sectionKicker">À SURVEILLER</span>
            <button type="button" onClick={() => onOpenTab('vigilance')}>
              Vigilance {typeof vigilance.score === 'number' ? `${vigilance.score}/100` : ''} →
            </button>
          </div>
          <div className="signalRows">
            {warningTraps.slice(0, 2).map((trap: any) => (
              <div className="signalRow" key={trap.id || trap.label}>
                <span className="signalIcon signalIconWarn" aria-hidden="true">
                  !
                </span>
                <div>
                  <b>{trap.label}</b>
                  {trap.detail ? <p>{trap.detail}</p> : null}
                </div>
              </div>
            ))}
            {warningTraps.length === 0 && vigilance.reasons?.[0] ? (
              <div className="signalRow">
                <span className="signalIcon signalIconWarn" aria-hidden="true">
                  !
                </span>
                <div>
                  <b>Vigilance · {vigilance.level || '—'}</b>
                  <p>{vigilance.reasons[0]}</p>
                </div>
              </div>
            ) : null}
            {absenceCount > 0 ? (
              <div className="signalRow">
                <span className="signalIcon" aria-hidden="true">
                  ✚
                </span>
                <div>
                  <b>
                    {absenceCount} absence{absenceCount > 1 ? 's' : ''} signalée{absenceCount > 1 ? 's' : ''}
                  </b>
                  <p>
                    {homeAbsences.length > 0
                      ? `${fixture.home?.short} : ${homeAbsences.map((p: any) => p.name).join(', ')}. `
                      : `${fixture.home?.short} : aucune. `}
                    {awayAbsences.length > 0
                      ? `${fixture.away?.short} : ${awayAbsences.map((p: any) => p.name).join(', ')}.`
                      : `${fixture.away?.short} : aucune.`}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ---------------- Faits marquants ---------------- */}
      {insights.length > 0 ? (
        <section className="overviewFacts" aria-label="Faits marquants">
          <span className="sectionKicker">FAITS MARQUANTS</span>
          <ul>
            {insights.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------- Raccourcis vers le détail ---------------- */}
      <nav className="overviewActions" aria-label="Aller plus loin">
        <button type="button" onClick={() => onOpenTab('pronostics')}>
          <b>{marketCount > 0 ? `${marketCount} marchés` : 'Marchés'}</b>
          <small>1X2, buts, mi-temps</small>
        </button>
        <button type="button" onClick={() => onOpenTab('facteurs')}>
          <b>8 facteurs</b>
          <small>forme, absences, xG</small>
        </button>
        <button type="button" onClick={() => onOpenTab('analyste')}>
          <b>Rapport</b>
          <small>{market.available ? 'marché comparé' : 'modèle pur'}</small>
        </button>
      </nav>

      <p className="legalNote">
        Les probabilités sont des estimations statistiques. Elles ne constituent ni conseil de pari ni garantie de résultat.
      </p>
    </div>
  );
}

export default MatchOverview;
