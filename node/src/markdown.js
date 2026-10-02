/**
 * A small HTML to Markdown converter.
 *
 * Enough to turn a documentation page or an article into something readable and
 * compact enough to hand to a model: block structure preserved, scripts and
 * styling dropped, links kept with their text.
 *
 * It is deliberately not a parser for the whole HTML spec. Anything it does not
 * understand falls through as text, which is the safe direction to be wrong in.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Elements that are removed with their contents, not unwrapped. */
const DROPPED = /<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi;

/**
 * Page furniture: the parts that are on every page and in none of them. Left in,
 * they push the actual article below a hundred lines of menus -- on the Wikipedia
 * page for Aurora the sidebar runs to about a hundred lines before the first
 * heading of the article itself.
 *
 * Each pattern removes the element together with its contents, because unwrapping
 * a nav element would leave its links behind as though they were body text.
 */
const CHROME = [
  /<(nav|aside)\b[\s\S]*?<\/\1>/gi,
  /<header\b[\s\S]*?<\/header>/gi,
  /<footer\b[\s\S]*?<\/footer>/gi,
  // The same furniture, marked by role rather than by tag.
  /<(\w+)\b[^>]*\brole=["']navigation["'][^>]*>[\s\S]*?<\/\1>/gi,
  // Accessibility skip links exist to be skipped.
  /<a\b[^>]*\bclass=["'][^"']*(?:skip|mw-jump)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi,
  // Wikipedia's own sidebar, toolbar and per-section furniture.
  /<div\b[^>]*\bid=["'](?:mw-navigation|p-views|mw-footer|mw-header|mw-indicators)["'][^>]*>[\s\S]*?<\/div>/gi,
  /<div\b[^>]*\bclass=["'][^"']*(?:mw-editsection|navbox|vertical-navbox)["'][^>]*>[\s\S]*?<\/div>/gi,
];
/**
 * Tags that only mean "start a new block", replaced by blank lines.
 *
 * Headings, list items, preformatted blocks and blockquotes are deliberately
 * absent: each carries meaning that inline() still needs, and blanking the tags
 * out first is what turns a heading into a bare sentence and a list into a
 * paragraph.
 */
const BLOCKS = /<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|table|thead|tbody|tr|figure|figcaption|form|dl|dt|dd|address)\b[^>]*>/gi;

function inline(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `**${inner.trim()}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `_${inner.trim()}_`)
    .replace(/<(code|kbd|samp)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `\`${inner.replace(/\s+/g, ' ').trim()}\``)
    .replace(/<del\b[^>]*>([\s\S]*?)<\/del>/gi, '~~$1~~')
    .replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, inner) => (inner.trim() ? `[${inner.trim()}](${href})` : ''))
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, '![$1]')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, level, inner) => `\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_m, inner) => `\n${stripTags(inner).trim().split('\n').map((line) => `> ${line}`).join('\n')}\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_m, inner) => `\n\`\`\`\n${decodeEntities(stripTags(inner)).replace(/\n+$/, '')}\n\`\`\`\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `\n- ${stripTags(inner).trim()}`)
    .replace(/<[^>]+>/g, '');
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ''));
}

/** Turns an HTML document into Markdown. */
export function htmlToMarkdown(html) {
  const body = String(html)
    // Attribute values are dropped before anything else looks at the markup.
    // A data-* attribute can hold a few kilobytes of JSON containing '>', which
    // splits the tag it sits in and spills the whole thing into the text.
    .replace(/\s(?:data-[\w-]+|aria-[\w-]+|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(DROPPED, ' ')
    .replace(CHROME[0], ' ')
    .replace(CHROME[1], ' ')
    .replace(CHROME[2], ' ')
    .replace(CHROME[3], ' ')
    .replace(CHROME[4], ' ')
    .replace(CHROME[5], ' ')
    .replace(CHROME[6], ' ')
    .replace(BLOCKS, '\n\n');
  const withNewlines = inline(body);
  return decodeEntities(withNewlines)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The visible text of a document, for callers that want prose without the
 * structure.
 */
export function htmlToText(html) {
  return htmlToMarkdown(html)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[>#\-+*|\s]+/gm, '')
    .replace(/\*\*|~~|`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
