/**
 * The Typst side of the CV layout: a component library plus the page setup that drives it.
 *
 * Every vertical space, colour and weight lives here rather than being emitted per line by the renderer, so the
 * document has one rhythm instead of a dozen hand-tuned block deltas. `u` is the density knob — the renderer recompiles
 * at a smaller `u` when that removes a nearly empty trailing page, and only sizes and spacing scale with it.
 */
export function cvPreamble(density: number, lang: string): string {
  return `#let u = ${density.toFixed(3)}

#let theme = (
  accent: rgb("#b0553c"),
  ink: rgb("#16181b"),
  muted: rgb("#6a7078"),
  hairline: rgb("#d9d2ce"),
)
#let body-font = "Spectral"
#let label-font = ("JetBrains Mono", "Spectral")

#set page(
  width: 595.28pt, height: 841.89pt,
  margin: (top: 46pt * u, bottom: 40pt * u, left: 52pt, right: 52pt),
)
#set text(font: body-font, size: 9.6pt * u, fill: theme.ink, lang: "${lang}", hyphenate: false)
// Leading stays below the gaps set between list items and grid rows: if a wrapped line were spaced as widely as two
// separate bullets, the eye would group the wrong lines together.
#set par(justify: false, leading: 0.56em, spacing: 0pt)
#show strong: set text(weight: 700)
// Spectral ships no italic face. Emphasis is left as a pure style request so that it is a no-op until an italic is
// installed: tinting it instead made cited titles read as disabled text next to the muted dates column.
#show emph: set text(style: "italic")

/// Name, headline and contact row, closed by the rule that separates the header from the body.
/// Each line is its own block: inside one paragraph they would collapse onto the body leading and read as a clump.
#let cv-header(name, headline, contacts) = block(width: 100%, below: 17pt * u)[
  #block(below: 7pt * u)[
    #text(size: 23pt * u, weight: 700, fill: theme.accent, tracking: -0.15pt)[#name]
  ]
  #if headline != none [
    #block(below: 6pt * u)[#text(size: 11pt * u, fill: theme.ink)[#headline]]
  ]
  #if contacts.len() > 0 [
    #block(below: 10pt * u)[
      #text(size: 8.8pt * u, fill: theme.muted)[#contacts.join(text(fill: theme.hairline)[ | ])]
    ]
  ]
  #line(length: 100%, stroke: 0.7pt + theme.hairline)
]

/// A section label and its blocks. The label is sticky so it can never be stranded at the foot of a page.
#let cv-section(title, body) = block(width: 100%, above: 14pt * u, below: 0pt, breakable: true)[
  // No letter-spacing: a tracked label extracts from the PDF as "S K I L L S", and these CVs are read by ATS
  // parsers before they are read by people. The monospaced label face already gives the width the tracking bought.
  #block(sticky: true, below: 6pt * u)[
    #text(font: label-font, size: 8.8pt * u, weight: 700, fill: theme.accent)[#upper(title)]
  ]
  #body
]

/// Hanging-indent list with an accent marker. Typst owns the wrap, so continuation lines align under the text.
#let cv-bullets(items) = block(width: 100%, above: 0pt, below: 0pt)[
  #set list(marker: text(fill: theme.accent)[#sym.bullet], indent: 1pt, body-indent: 7pt)
  #list(tight: false, spacing: 5.4pt * u, ..items)
]

/// A dated record: title and role on one line, dates on the next. The whole head sticks to whatever follows it.
#let cv-entry(title, subtitle, meta, summary, bullets) = block(width: 100%, above: 17pt * u, below: 0pt, breakable: true)[
  #block(sticky: true, below: 6.5pt * u)[
    #block(below: if meta != none { 5.5pt * u } else { 0pt })[
      #text(size: 10pt * u)[
        #text(weight: 700)[#title]
        #if subtitle != none [#text(fill: theme.hairline)[ #sym.dot.c ] #subtitle]
      ]
    ]
    #if meta != none [#block[#text(size: 8.7pt * u, fill: theme.muted)[#meta]]]
  ]
  #if summary != none [#block(below: 4.5pt * u, width: 100%)[#summary]]
  #if bullets.len() > 0 [#cv-bullets(bullets)]
]

/// Label/value rows for skills, tooling and languages. The label runs into its value rather than heading a second
/// column, so a long value wraps to the full measure like every other paragraph on the page.
#let cv-facts(items) = block(width: 100%, above: 0pt, below: 0pt)[
  #set par(spacing: 5.4pt * u)
  #items.map(item => [#text(weight: 700)[#item.term]: #item.detail]).join(parbreak())
]

/// A paragraph of prose between blocks.
#let cv-text(body) = block(width: 100%, above: 0pt, below: 0pt)[#body]

/// Vertical air between sibling blocks inside a section. Not weak: it must survive next to the blocks' own spacing.
#let cv-gap = v(5.5pt * u)
`;
}
