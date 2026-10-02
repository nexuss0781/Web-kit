import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, htmlToText, decodeEntities } from '../src/markdown.js';
import { extractMetadata } from '../src/html.js';

test('entities decode, including numeric and hex', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;');
});

test('structure is kept and noise is dropped', () => {
  const html = `<html><head><title>T</title><style>body{color:red}</style></head><body>
    <script>alert('x')</script>
    <h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> text.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre><code>const x = 1;</code></pre>
    <a href="https://example.com/target">link text</a>
  </body></html>`;
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /# Title/);
  assert.match(markdown, /\*\*bold\*\*/);
  assert.match(markdown, /_italic_/);
  assert.match(markdown, /- one/);
  assert.match(markdown, /```[\s\S]*const x = 1;[\s\S]*```/);
  assert.match(markdown, /\[link text\]\(https:\/\/example\.com\/target\)/);
  assert.doesNotMatch(markdown, /alert/);
  assert.doesNotMatch(markdown, /color:red/);
  assert.doesNotMatch(markdown, /<h1>|<p>|<ul>/);
});

test('text form drops the markdown furniture', () => {
  const text = htmlToText('<h2>Head</h2><p>Body with `code` and a [link](https://x.test).</p>');
  assert.match(text, /Head/);
  assert.match(text, /Body with code and a link\./);
  assert.doesNotMatch(text, /```|\]\(/);
});

test('metadata prefers declared values and falls back to the title', () => {
  const rich = extractMetadata(
    `<html lang="fr"><head><meta property="og:title" content="OG title"><meta name="description" content="Desc">
     <link rel="canonical" href="https://x.test/canonical"><a href="/a">a</a><a href="https://y.test/b">b</a></head></html>`,
    'https://x.test/page');
  assert.equal(rich.title, 'OG title');
  assert.equal(rich.description, 'Desc');
  assert.equal(rich.canonical_url, 'https://x.test/canonical');
  assert.equal(rich.language, 'fr');
  assert.deepEqual(rich.links, ['https://x.test/a', 'https://y.test/b']);

  const plain = extractMetadata('<title>Only a title</title>', 'https://x.test/');
  assert.equal(plain.title, 'Only a title');
  assert.equal(plain.canonical_url, null, 'no canonical link means the page never declared one');
  assert.deepEqual(extractMetadata('', 'https://x.test/').links, []);
});

test('page furniture is removed with its links, not unwrapped', () => {
  // Unwrapping a nav element would leave its links in the output as if they
  // were body text, which is what put a hundred lines of Wikipedia sidebar
  // above the article.
  const html = `<body>
    <nav><a href="/home">Home</a><a href="/about">About</a></nav>
    <header><h1>Site header</h1></header>
    <div role="navigation"><a href="/x">Sidebar</a></div>
    <a class="mw-jump-link" href="#body">Jump to content</a>
    <main><h1>Aurora</h1><p>The article.</p></main>
    <aside>Related links</aside>
    <footer>Copyright</footer>
  </body>`;
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /# Aurora/);
  assert.match(markdown, /The article\./);
  for (const junk of ['Home', 'About', 'Sidebar', 'Site header', 'Jump to content', 'Related links', 'Copyright']) {
    assert.ok(!markdown.includes(junk), `${junk} should have been dropped`);
  }
});

test('a data attribute full of markup does not spill into the text', () => {
  // MediaWiki and friends embed JSON containing '>' in data-* attributes, which
  // splits the tag and leaks the payload into the output.
  const html = `<p data-mw='{"parts":[{"template":{"target":">"}}]}'>Real text.</p>`;
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /Real text\./);
  assert.ok(!markdown.includes('template'), 'the JSON payload is gone');
  assert.ok(!markdown.includes('parts'), 'the JSON payload is gone');
});
