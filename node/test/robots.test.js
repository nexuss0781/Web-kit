import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../src/robots.js';

const RULES = `
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Crawl-delay: 5

User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /other
`;

test('groups are separated by user agent, and the last matching one wins', () => {
  const rules = parseRobots(RULES, 'Web-Kit');
  assert.ok(isAllowed(rules, '/public/page'));
  assert.ok(!isAllowed(rules, '/private/secret'), 'Disallow /private covers it');
  assert.ok(isAllowed(rules, '/private/public/page'), 'the longer Allow wins over the shorter Disallow');
  assert.ok(!isAllowed(rules, '/other'), 'a second matching group adds to the first');
  assert.ok(!isAllowed(rules, '/report.pdf'), 'wildcards and end anchors are honoured');
  assert.ok(isAllowed(rules, '/report.pdf.html'), 'the $ anchor is not a loose match');
  assert.ok(isAllowed(rules, '/'), 'the site root is not covered by a disallow');
});

test('a named agent gets its own rules and the wildcard group is not applied', () => {
  const rules = parseRobots(RULES, 'BadBot');
  assert.ok(!isAllowed(rules, '/anything'), 'BadBot is shut out entirely');
  assert.ok(!isAllowed(rules, '/other'), 'the wildcard groups do not leak into a named agent');
});

test('an empty or missing file allows everything', () => {
  for (const text of ['', '# just a comment', 'User-agent: *']) {
    assert.ok(isAllowed(parseRobots(text, 'Web-Kit'), '/anything'));
  }
});

test('rules without a user-agent line are ignored', () => {
  const rules = parseRobots('Disallow: /everything', 'Web-Kit');
  assert.ok(isAllowed(rules, '/everything'));
});

test('a user-agent match ignores case and takes the specific name over *', () => {
  const text = 'User-agent: *\nDisallow: /all\n\nUser-agent: NiceBot\nDisallow: /none';
  assert.ok(isAllowed(parseRobots(text, 'nicebot'), '/all'), 'the * group does not apply to a named agent');
  assert.ok(!isAllowed(parseRobots(text, 'nicebot'), '/none'));
  assert.ok(isAllowed(parseRobots(text, 'nicebot'), '/something'));
  assert.ok(!isAllowed(parseRobots(text, 'Other'), '/all/page'), 'everyone else still gets the * group');
});
