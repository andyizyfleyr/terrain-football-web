'use client';

import { Fixture } from '../lib/terrain';
import { ProbBar } from './ProbBar';

/**
 * GRILLE DES PROBABILITÉS DÉTAILLÉES
 *
 * Les cartes 1X2, BTTS, totaux, scores exacts et buts par période.
 * Extraite du panneau d'analyse pour être partagée :
 * - sur la fiche match (desktop et mobile), elle est affichée d'emblée ;
 * - dans la feuille d'accueil, elle est repliée sous « Détail complet »,
 *   car l'aperçu compact en résume déjà l'essentiel.
 *
 * Une seule implémentation : les deux contextes ne peuvent pas diverger.
 */
export function MatchProbabilities({
  analysis,
  analyst,
  fixture,
}: {
  analysis: any;
  analyst: any;
  fixture: Fixture;
}) {
  const probabilities = analysis?.probabilities || {};

  return (
    <div className="predictionGrid">
      <article className="predictionCard">
        <div className="cardHeading">
          <span>1X2</span>
          <div>
            <b>Résultat final</b>
            <small>Temps réglementaire</small>
          </div>
        </div>
        <ProbBar
          label={`Victoire · ${fixture.home?.short || 'domicile'}`}
          value={probabilities.home}
          interval={analyst?.uncertainty?.home}
        />
        <ProbBar
          label="Match nul"
          value={probabilities.draw}
          color="var(--gold)"
          interval={analyst?.uncertainty?.draw}
        />
        <ProbBar
          label={`Victoire · ${fixture.away?.short || 'extérieur'}`}
          value={probabilities.away}
          color="var(--blue)"
          interval={analyst?.uncertainty?.away}
        />
      </article>

      <article className="predictionCard">
        <div className="cardHeading">
          <span>↗</span>
          <div>
            <b>Les deux équipes marquent</b>
            <small>BTTS · match entier</small>
          </div>
        </div>
        <ProbBar label="Oui · les deux équipes marquent" value={probabilities.bttsYes} />
        <ProbBar label="Non · une équipe muette" value={probabilities.bttsNo} color="var(--blue)" />
      </article>

      <article className="predictionCard">
        <div className="cardHeading">
          <span>Σ</span>
          <div>
            <b>Total de buts</b>
            <small>Plus / moins · match entier</small>
          </div>
        </div>
        <ProbBar label="Plus de 1,5 buts" value={probabilities.over15} />
        <ProbBar label="Moins de 1,5 buts" value={probabilities.under15} color="var(--blue)" />
        <ProbBar label="Plus de 2,5 buts" value={probabilities.over25} />
        <ProbBar label="Moins de 2,5 buts" value={probabilities.under25} color="var(--blue)" />
      </article>

      <article className="predictionCard">
        <div className="cardHeading">
          <span>⌗</span>
          <div>
            <b>Scores les plus probables</b>
            <small>Estimations du modèle</small>
          </div>
        </div>
        {(analysis?.topScores || []).slice(0, 5).map((score: any) => (
          <ProbBar key={`${score.h}-${score.a}`} label={`${score.h} – ${score.a}`} value={score.p} />
        ))}
      </article>

      <article className="predictionCard fullPrediction">
        <div className="cardHeading">
          <span>½</span>
          <div>
            <b>Buts par période</b>
            <small>Probabilités par mi-temps</small>
          </div>
        </div>
        <div className="periodRows">
          {(
            [
              ['1re mi-temps', probabilities.firstHalf],
              ['2e mi-temps', probabilities.secondHalf],
            ] as any
          ).map(([label, period]: any) => (
            <div className="periodGroup" key={label}>
              <span className="periodGroupLabel">{label}</span>
              {(
                [
                  ['1,5', period?.over15],
                  ['2,5', period?.over25],
                ] as any
              ).map(([line, value]: any) => (
                <div key={line}>
                  <ProbBar label={`Plus de ${line} buts`} value={value} />
                  <ProbBar
                    label={`Moins de ${line} buts`}
                    value={typeof value === 'number' ? 1 - value : undefined}
                    color="var(--blue)"
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
        <small className="tableNote">Estimations par période, indépendantes du score à la pause.</small>
      </article>
    </div>
  );
}

export default MatchProbabilities;
