'use client';

import Link from 'next/link';
import { countdownLabel, Fixture, isFixtureFinished, timeOf } from '../lib/terrain';
import { pickBadges, type MatchTag } from '../lib/matchTags';
import { TeamBadge } from './TeamBadge';

type MatchCardProps = {
  fixture: Fixture;
  href: string;
  onOpen?: (event: React.MouseEvent<HTMLAnchorElement>, fixture: Fixture) => void;
  highlighted?: boolean;
  vigilance?: any;
  /** Étiquettes de la rencontre (3 maximum affichées). */
  tags?: MatchTag[] | null;
};

/**
 * Carte de rencontre : rail horaire à gauche, équipes au centre,
 * résultat et action à droite.
 *
 * Le balisage est commun aux deux mises en page. Sur mobile, `mobile.css`
 * réorganise les zones en grille (`rail` / `side` / `body`) et transforme
 * les équipes en lignes de type « feuille de match » avec le score aligné
 * à droite — la grille desktop n'est pas touchée.
 */
export function MatchCard({ fixture, href, onOpen, highlighted, vigilance, tags }: MatchCardProps) {
  const finished = isFixtureFinished(fixture);
  const countdown = countdownLabel(fixture.date);
  const badges = pickBadges(tags);

  return (
    <Link
      href={href}
      prefetch={false}
      className={`matchCard ${highlighted ? 'matchCardActive' : ''}`}
      onClick={onOpen ? event => onOpen(event, fixture) : undefined}
    >
      <span className="matchCardRail">
        <b>{timeOf(fixture.date)}</b>
        <small>COT</small>
      </span>

      <span className="matchCardBody">
        <span className="matchCardTeam">
          <TeamBadge team={fixture.home} size={30} />
          <b>{fixture.home?.name}</b>
          {finished ? <span className="matchCardTeamScore">{fixture.home?.score}</span> : null}
        </span>
        <span className="matchCardTeam">
          <TeamBadge team={fixture.away} size={30} />
          <b>{fixture.away?.name}</b>
          {finished ? <span className="matchCardTeamScore">{fixture.away?.score}</span> : null}
        </span>
        <span className="matchCardVenue">{fixture.venue || 'Lieu non renseigné'}</span>
        {badges.length > 0 && (
          <span className="matchCardTags">
            {badges.map(tag => (
              <span
                key={tag.id}
                className={`matchTagBadge matchTag_${tag.id.replace('-', '_')}`}
                title={tag.reason}
              >
                <i aria-hidden="true">{tag.emoji}</i>
                {tag.label}
              </span>
            ))}
          </span>
        )}
      </span>

      <span className="matchCardSide">
        {finished ? (
          <span className="matchCardScore">
            {fixture.home?.score}
            <i>–</i>
            {fixture.away?.score}
          </span>
        ) : (
          <span className="matchCardState">{countdown}</span>
        )}
        {vigilance ? (
          <span className={`matchCardRisk ${vigilance.score >= 30 ? 'matchCardRiskHigh' : ''}`}>{vigilance.score}</span>
        ) : null}
        <span className="matchCardGo" aria-hidden="true">
          →
        </span>
      </span>
    </Link>
  );
}
