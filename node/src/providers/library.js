/**
 * Open Library, for books, and Crossref, for published papers and their
 * metadata. Both are keyless, both answer in JSON, and between them they cover
 * the two kinds of reference material a search usually turns up and web scrapers
 * are bad at.
 */

import { getJson, url } from '../http.js';

async function searchOpenLibrary(request, config) {
  const startedAt = Date.now();
  const data = await getJson(url('https://openlibrary.org/search.json', {
    q: request.query,
    limit: Math.min(request.limit ?? 10, 20),
    fields: 'key,title,author_name,first_publish_year,subject',
  }), { timeoutMs: config.searchTimeoutMs });

  return {
    latency: Date.now() - startedAt,
    rows: (data.docs ?? []).map((doc) => {
      const authors = (doc.author_name ?? []).slice(0, 3).join(', ');
      const parts = [];
      if (authors) parts.push(authors);
      if (doc.first_publish_year) parts.push(String(doc.first_publish_year));
      if (doc.subject?.length) parts.push(doc.subject.slice(0, 4).join(', '));
      return {
        title: String(doc.title ?? '').trim(),
        url: doc.key ? `https://openlibrary.org${doc.key}` : '',
        snippet: parts.join(' · ').slice(0, 400),
      };
    }).filter((row) => row.url && row.title),
  };
}

async function searchCrossref(request, config) {
  const startedAt = Date.now();
  const data = await getJson(url('https://api.crossref.org/works', {
    query: request.query,
    rows: Math.min(request.limit ?? 10, 20),
    select: 'DOI,title,author,issued,container-title,type',
    // Without a contact address Crossref asks every caller to be polite and
    // puts it in the slower pool; the run time is the only contact it wants.
    'mailto': 'web-kit@example.invalid',
  }), { timeoutMs: config.searchTimeoutMs, headers: { 'user-agent': 'Web-Kit/0.1 (mailto:web-kit@example.invalid)' } });

  const rows = (data.message?.items ?? []).map((work) => {
    const title = Array.isArray(work.title) ? work.title[0] : work.title;
    const authors = (work.author ?? []).slice(0, 3).map((author) => [author.given, author.family].filter(Boolean).join(' ')).join(', ');
    const venue = Array.isArray(work['container-title']) ? work['container-title'][0] : '';
    const year = work.issued?.['date-parts']?.[0]?.[0];
    const parts = [authors, venue, year].filter(Boolean);
    return {
      title: String(title ?? '').trim(),
      url: work.DOI ? `https://doi.org/${work.DOI}` : '',
      snippet: parts.join(' · ').slice(0, 400),
    };
  }).filter((row) => row.url && row.title);
  return { latency: Date.now() - startedAt, rows };
}

export const openlibrary = {
  id: 'openlibrary',
  label: 'Open Library',
  capabilities: ['search'],
  search: searchOpenLibrary,
};

export const crossref = {
  id: 'crossref',
  label: 'Crossref',
  capabilities: ['search'],
  search: searchCrossref,
};
