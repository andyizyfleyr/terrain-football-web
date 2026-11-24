'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

type NavItem =
  | { kind: 'link'; href: string; label: string; active?: boolean }
  /** Ancre interne (`#rencontres`) : pas de rechargement de la page. */
  | { kind: 'anchor'; href: string; label: string; active?: boolean }
  | { kind: 'button'; label: string; onClick: () => void }
  | { kind: 'current'; label: string };

type SiteHeaderProps = {
  /** Élément courant de la navigation (sans lien : c'est la page affichée). */
  items: NavItem[];
  /**
   * Accès rapide affiché sur mobile uniquement.
   *
   * La barre de navigation est masquée sous 760 px : sans ce point
   * d'entrée, une page ajoutée au menu serait inatteignable au doigt.
   */
  quickAction?: { href: string; label: string };
  children?: ReactNode;
};

/**
 * En-tête commun aux pages du site.
 *
 * Le même balisage qu'historiquement (`.appHeader`, `.mainNav`) : il est
 * donc stylé par `globals.css` et `mobile.css` sans surcouche dédiée. Sur
 * mobile la navigation est masquée (`mobile.css`), la page doit donc
 * rester utilisable sans elle — c'est le cas de la page « Tous les
 * matchs », dont les filtres sont dans le corps.
 */
export function SiteHeader({ items, quickAction, children }: SiteHeaderProps) {
  return (
    <header className="appHeader">
      <Link className="brand" href="/" aria-label="Terrain, accueil">
        <span className="brandMark">T</span>
        <span className="brandWords">
          TERRAIN
          <small>FOOTBALL INTELLIGENCE</small>
        </span>
      </Link>
      <nav className="mainNav" aria-label="Navigation principale">
        {items.map(item => {
          if (item.kind === 'link') {
            return (
              <Link key={item.label} href={item.href} className={item.active ? 'navActive' : undefined}>
                {item.label}
              </Link>
            );
          }
          if (item.kind === 'anchor') {
            return (
              <a key={item.label} href={item.href} className={item.active ? 'navActive' : undefined}>
                {item.label}
              </a>
            );
          }
          if (item.kind === 'button') {
            return (
              <button key={item.label} type="button" className="navLinkButton" onClick={item.onClick}>
                {item.label}
              </button>
            );
          }
          return (
            <span key={item.label} className="navCurrent" aria-current="page">
              {item.label}
            </span>
          );
        })}
      </nav>
      {quickAction ? (
        <Link className="headerQuick" href={quickAction.href}>
          {quickAction.label}
        </Link>
      ) : null}
      {children}
    </header>
  );
}

/** Pied de page commun. */
export function SiteFooter() {
  return (
    <footer className="appFooter">
      <span>© TERRAIN · FOOTBALL INTELLIGENCE</span>
      <span>DONNÉES STATISTIQUES PUBLIQUES · ESTIMATIONS, JAMAIS DES CERTITUDES</span>
    </footer>
  );
}
