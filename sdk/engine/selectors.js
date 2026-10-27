/**
 * Reading attributes out of markup, without a DOM.
 *
 * Firecrawl's `attributes` format is a list of CSS selectors and the attribute
 * to read from each match: `{ selector: 'a[data-id]', attribute: 'data-id' }`
 * answers with every value on the page. Pages that publish inventory, prices
 * or identifiers in data attributes are common enough that this is worth
 * answering locally rather than refusing.
 *
 * This is a scanner, not a browser. It understands type, class, id and
 * attribute selectors, and a descendant or child combinator collapses to its
 * last compound -- `div.card > a[href]` reads the `a[href]` that the caller
 * actually wanted. It does not run scripts, resolve CSS variables or compute
 * layout, and a selector that depends on any of that is a selector this service
 * cannot answer, not one it silently answers with nothing.
 *
 * Nothing here is a parser in the sense a browser has one. It is text scanning
 * over the same bytes the caller's selectors were written against, which is
 * enough for extraction and small enough to stay honest about its limits.
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** How many values one selector may return, so a table cannot flood a reply. */
const MAX_VALUES_PER_SELECTOR = 500;

const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

function attributesOf(source) {
  const attrs = new Map();
  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase();
    // A bare `/` or a stray `=` from malformed markup is not an attribute.
    if (!/^[a-z_:][\w:.-]*$/.test(name)) continue;
    attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Every tag in the document, in order, with where it starts and ends.
 *
 * Both opening and closing tags are kept: text extraction needs the closing tag
 * to know where an element's content stops, and the nesting count needs it to
 * tell a nested `<div>` from the end of the outer one.
 */
function tokenize(html) {
  const tokens = [];
  for (const match of html.matchAll(TAG)) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const end = match.index + match[0].length;
    tokens.push({
      name,
      closing,
      start: match.index,
      end,
      selfClosing: !closing && (match[3].trimEnd().endsWith('/') || VOID_ELEMENTS.has(name)),
      attrs: closing ? new Map() : attributesOf(match[3]),
    });
  }
  return tokens;
}

function parseSelector(selector) {
  const raw = String(selector ?? '').trim();
  // Pseudo-classes describe state or position, neither of which exists here.
  // Dropping them keeps the element part of the selector usable.
  const withoutPseudos = raw.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
  // A combinator picks a relationship; the last compound is the element being
  // read, which is the part an attribute extraction cares about.
  const last = withoutPseudos.replace(/\s*[>+~]\s*/g, ' ').trim().split(/\s+/).pop() ?? '';
  if (!last) return null;

  const selectorParts = { tag: null, id: null, classes: [], attrs: [] };
  const pattern = /(^[a-zA-Z][\w:-]*|\*)|\.([\w-]+)|#([\w-]+)|\[([\w:-]+)(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  for (const match of last.matchAll(pattern)) {
    if (match[0] === '*' && match[1] === '*') continue;
    if (match[1]) selectorParts.tag = match[1].toLowerCase();
    else if (match[2]) selectorParts.classes.push(match[2]);
    else if (match[3]) selectorParts.id = match[3];
    else if (match[4]) {
      selectorParts.attrs.push({
        name: match[4].toLowerCase(),
        operator: match[5] ?? null,
        value: match[6] ?? match[7] ?? match[8] ?? '',
      });
    }
  }
  return selectorParts;
}

function attributeMatches(actual, operator, expected) {
  if (operator === null) return actual !== undefined;
  if (actual === undefined) return false;
  switch (operator) {
    case '=': return actual === expected;
    case '~=': return actual.split(/\s+/).includes(expected);
    case '^=': return actual.startsWith(expected);
    case '$=': return actual.endsWith(expected);
    case '*=': return actual.includes(expected);
    case '|=': return actual === expected || actual.startsWith(`${expected}-`);
    default: return false;
  }
}

function matches(token, selectorParts) {
  if (selectorParts.tag && token.name !== selectorParts.tag) return false;
  if (selectorParts.id && token.attrs.get('id') !== selectorParts.id) return false;
  if (selectorParts.classes.length) {
    const classes = (token.attrs.get('class') ?? '').split(/\s+/);
    for (const name of selectorParts.classes) if (!classes.includes(name)) return false;
  }
  for (const wanted of selectorParts.attrs) {
    if (!attributeMatches(token.attrs.get(wanted.name), wanted.operator, wanted.value)) return false;
  }
  return true;
}

/**
 * The text between an element's start and its matching close tag.
 *
 * Nesting is counted so `<div><div>x</div>y</div>` reads `xy` and not the whole
 * document to the first `</div>`.
 */
function textOf(tokens, index, html) {
  const token = tokens[index];
  if (token.selfClosing) return '';
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const current = tokens[cursor];
    if (current.name !== token.name) continue;
    if (current.closing) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(token.end, current.start).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } else if (!current.selfClosing) {
      depth += 1;
    }
  }
  // An unclosed element is malformed markup; its content still exists.
  return html.slice(token.end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Reads the requested attribute from every element the selector matches.
 *
 * `attribute: 'text'` (or `'innerText'`) reads an element's text content, which
 * is the way to pull a label out of markup that stores the value it labels
 * separately.
 */
export function extractAttributes(html, selectors) {
  const source = String(html ?? '');
  if (!source.trim() || !Array.isArray(selectors)) return [];

  const tokens = tokenize(source);
  const results = [];
  for (const entry of selectors) {
    if (!entry || typeof entry.selector !== 'string' || typeof entry.attribute !== 'string') continue;
    const parts = parseSelector(entry.selector);
    if (!parts) continue;
    const readingText = entry.attribute === 'text' || entry.attribute === 'innerText' || entry.attribute === 'textContent';
    const wanted = entry.attribute.toLowerCase();
    const values = [];

    for (const [index, token] of tokens.entries()) {
      if (token.closing || !matches(token, parts)) continue;
      const value = readingText ? textOf(tokens, index, source) : token.attrs.get(wanted);
      if (value === undefined || value === '') continue;
      if (!values.includes(value)) values.push(value);
      if (values.length >= MAX_VALUES_PER_SELECTOR) break;
    }

    results.push({ selector: entry.selector, attribute: entry.attribute, values });
  }
  return results;
}

export { parseSelector, tokenize };
