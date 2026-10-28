/**
 * POST /v2/download
 * GET /v2/download/:id
 * DELETE /v2/download/:id
 *
 * Download a site/section as zip using map + batch scrape.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import { v2Map } from './map.js';
import { v2Scrape } from './compat.js';
import {
  addWarning,
  documentJobStatus,
  isExpired,
  newId,
  pruneJobs,
  readJob,
  removeJob,
  snapshot,
  statusUrl,
  writeJob,
  dataHome,
} from './jobs.js';

const MAX_URLS = 1000;
const DEFAULT_LIMIT = 100;
const DEFAULT_CONCURRENCY = 3;

const active = new Map();

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

function integer(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9._-]/gi, '_').slice(0, 200);
}

async function runDownload(runtime, config) {
  const { job } = runtime;
  const downloadsDir = path.join(dataHome(config), 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const zipPath = path.join(downloadsDir, `${job.id}.zip`);
  
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  
  archive.pipe(output);
  
  try {
    const limit = job.limit || DEFAULT_LIMIT;
    const mapResult = await v2Map({ url: job.url, limit, sitemap: job.sitemap }, config);
    const urls = (mapResult.links || []).slice(0, limit).map(l => l.url);
    
    job.total = urls.length;
    writeJob(config, 'download', snapshot(job));
    
    const results = [];
    for (let i = 0; i < urls.length; i += DEFAULT_CONCURRENCY) {
      if (runtime.cancelled) break;
      const batch = urls.slice(i, i + DEFAULT_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(url => v2Scrape({ url, formats: job.formats || ['markdown'] }, config))
      );
      
      for (let j = 0; j < batchResults.length; j++) {
        const res = batchResults[j];
        const url = batch[j];
        if (res.status === 'fulfilled' && res.value?.data) {
          const data = res.value.data;
          const filename = sanitizeFilename(url.replace(/^https?:\/\//, '').replace(/[^a-z0-9._-]/gi, '_')) + '.md';
          if (data.markdown) {
            archive.append(data.markdown, { name: filename });
          } else if (data.html) {
            archive.append(data.html, { name: filename.replace('.md', '.html') });
          }
          results.push({ url, status: 'success' });
        } else {
          addWarning(job, `${url}: ${res.reason?.message || 'failed'}`);
          results.push({ url, status: 'failed' });
        }
      }
      
      job.completed = Math.min(i + batch.length, urls.length);
      writeJob(config, 'download', snapshot(job));
    }
    
    await archive.finalize();
    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });
    
    job.status = runtime.cancelled ? 'cancelled' : 'completed';
    job.completed = urls.length;
    job.zipPath = zipPath;
    job.downloadUrl = `/v2/download/${job.id}/file`;
    job.completedAt = new Date().toISOString();
    writeJob(config, 'download', job);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    try { writeJob(config, 'download', job); } catch {}
  }
}

export async function v2DownloadStart(body = {}, config = {}) {
  const url = String(body.url || '').trim();
  if (!url) throw badRequest('url is required');
  
  const limit = integer(body.limit, 1, MAX_URLS, DEFAULT_LIMIT);
  const id = newId('download');
  
  const job = {
    id,
    url,
    status: 'scraping',
    completed: 0,
    total: 0,
    createdAt: new Date().toISOString(),
    warnings: [],
    limit,
    sitemap: body.sitemap || 'include',
    formats: body.formats || ['markdown'],
  };
  
  pruneJobs(config, 'download');
  const runtime = { job, cancelled: false };
  active.set(id, runtime);
  writeJob(config, 'download', snapshot(job));
  
  runtime.finished = runDownload(runtime, config).finally(() => active.delete(id));
  
  return { success: true, id, url: statusUrl(config, 'download', id) };
}

export function v2DownloadStatus(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) {
    const status = documentJobStatus(runtime.job);
    if (runtime.job.zipPath && runtime.job.status === 'completed') {
      status.downloadUrl = runtime.job.downloadUrl;
    }
    return { status: 200, json: status };
  }
  
  const stored = readJob(config, 'download', id);
  if (!stored) return { status: 404, json: { success: false, error: 'Download not found' } };
  if (isExpired(stored)) {
    removeJob(config, 'download', id);
    return { status: 404, json: { success: false, error: 'Download not found' } };
  }
  
  const status = documentJobStatus(stored);
  if (stored.zipPath && stored.status === 'completed') {
    status.downloadUrl = stored.downloadUrl;
  }
  return { status: 200, json: status };
}

export function v2DownloadCancel(id, config = {}) {
  const runtime = active.get(id);
  if (runtime) {
    runtime.cancelled = true;
    runtime.job.status = 'cancelled';
    runtime.job.completedAt = new Date().toISOString();
    return { status: 200, json: { success: true } };
  }
  
  const stored = readJob(config, 'download', id);
  if (!stored || isExpired(stored)) {
    return { status: 404, json: { success: false, error: 'Download not found' } };
  }
  if (stored.status === 'scraping' || stored.status === 'queued') {
    stored.status = 'cancelled';
    stored.completedAt = new Date().toISOString();
    try { writeJob(config, 'download', stored); } catch {}
  }
  return { status: 200, json: { success: true } };
}

export function v2DownloadFile(id, config = {}) {
  const stored = readJob(config, 'download', id);
  if (!stored || isExpired(stored)) {
    return { status: 404, json: { success: false, error: 'Download not found' } };
  }
  if (stored.status !== 'completed' || !stored.zipPath) {
    return { status: 404, json: { success: false, error: 'Download file not ready' } };
  }
  if (!fs.existsSync(stored.zipPath)) {
    return { status: 404, json: { success: false, error: 'Download file missing' } };
  }
  return {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="webkit-download-${id}.zip"`,
    },
    body: fs.readFileSync(stored.zipPath),
  };
}
