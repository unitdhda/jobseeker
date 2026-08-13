import type { CvLanguage } from './extract.ts';

function assertDensity(density: number): void {
  if (!Number.isFinite(density) || density < 0.75 || density > 1) {
    throw new RangeError(`Invalid CV density: expected a finite number from 0.75 through 1, received ${density}.`);
  }
}

/** Fixed component library: all styling stays here, while generated documents may emit calls only. */
export function cvPreamble(density: number, language: CvLanguage): string {
  assertDensity(density);
  if (language !== 'ru' && language !== 'en') throw new TypeError('Invalid CV language: expected ru or en.');
  const scale = density.toFixed(2);
  return `#set page(paper: "a4", margin: (x: 17mm, y: 14mm))
#set text(font: "Spectral", size: ${scale} * 10pt, lang: "${language}")
#set par(justify: false, leading: ${scale} * 0.58em)
#set list(indent: 1.15em, body-indent: 0.45em, spacing: ${scale} * 0.22em)
#let accent = rgb("#24556d")
#let cv-header(name, headline: none, contacts: ()) = {
  text(size: ${scale} * 22pt, weight: "bold", fill: accent, name)
  if headline != none { parbreak(); text(size: ${scale} * 11pt, headline) }
  if contacts.len() > 0 { parbreak(); text(font: "JetBrains Mono", size: ${scale} * 8.3pt, contacts.join("  •  ")) }
  v(${scale} * 0.75em)
}
#let cv-section(title, body) = {
  block(breakable: false)[
    #v(${scale} * 0.7em)
    #text(font: "JetBrains Mono", size: ${scale} * 9pt, weight: "bold", fill: accent, upper(title))
    #line(length: 100%, stroke: 0.55pt + accent)
  ]
  body
}
#let cv-text(body) = { body; parbreak() }
#let cv-list(items) = list(..items.map(item => [#item]))
#let cv-entry(title, subtitle: none, meta: none, body: none, bullets: ()) = {
  block(breakable: false)[
    #grid(columns: (1fr, auto), gutter: 0.8em,
      [#text(weight: "bold", title)#if subtitle != none { [ — #subtitle] }],
      [#if meta != none { text(font: "JetBrains Mono", size: ${scale} * 8.2pt, meta) }]
    )
  ]
  if body != none { body; parbreak() }
  if bullets.len() > 0 { cv-list(bullets) }
}
#let cv-facts(items) = grid(
  columns: (auto, 1fr),
  column-gutter: 0.8em,
  row-gutter: ${scale} * 0.25em,
  ..items.flatten().map(value => [#value]),
)
`;
}
