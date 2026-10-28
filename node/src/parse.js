/**
 * POST /v2/parse
 *
 * Local file parsing for PDF, DOCX, XLSX, XLS, ODT, RTF.
 * Accepts multipart/form-data (file), JSON with base64 + filename, or JSON with url.
 * Returns markdown + metadata.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseUrl } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const xlsx = require('xlsx');
import { fetchDocument } from './fetcher.js';
import { parseUrl as parseUrlSafe, assertPublicHost } from './safety.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_REQUEST' });
}

function getExtension(filename = '') {
  return path.extname(filename).toLowerCase().replace('.', '');
}

function mimeToExt(mime = '') {
  const m = mime.toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('wordprocessingml') || m.includes('msword')) return 'docx';
  if (m.includes('spreadsheetml') || m.includes('excel')) return 'xlsx';
  if (m.includes('rtf')) return 'rtf';
  if (m.includes('opendocument.text')) return 'odt';
  if (m.includes('opendocument.spreadsheet')) return 'ods';
  return null;
}

function parseContentDisposition(header) {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

async function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) throw badRequest('invalid multipart boundary');
  const boundary = '--' + boundaryMatch[1];
  const parts = buffer.toString('latin1').split(boundary);
  
  for (const part of parts) {
    if (part.includes('filename=')) {
      const filenameMatch = /filename="([^"]+)"/i.exec(part) || /filename=([^\s;]+)/i.exec(part);
      const filename = filenameMatch ? filenameMatch[1] : 'file';
      // Extract content after headers
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      let content = part.slice(headerEnd + 4);
      // Remove trailing \r\n
      if (content.endsWith('\r\n--')) content = content.slice(0, -4);
      else if (content.endsWith('--')) content = content.slice(0, -2);
      else if (content.endsWith('\r\n')) content = content.slice(0, -2);
      return { buffer: Buffer.from(content, 'latin1'), filename };
    }
  }
  throw badRequest('no file found in multipart data');
}

async function parseRTF(buffer) {
  try {
    const RtfParser = (await import('rtf-parser')).default;
    return new Promise((resolve, reject) => {
      RtfParser.string(buffer.toString('latin1'), (err, doc) => {
        if (err) return reject(err);
        // Simple extraction - convert to text/markdown
        let text = '';
        const extract = (node) => {
          if (node.content) {
            if (Array.isArray(node.content)) {
              node.content.forEach(extract);
            } else if (typeof node.content === 'string') {
              text += node.content;
            }
          }
        };
        if (doc.content) extract(doc);
        resolve({ markdown: text, html: text });
      });
    });
  } catch (e) {
    throw badRequest('rtf parsing failed: ' + e.message);
  }
}

async function parseODT(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const content = await zip.file('content.xml')?.async('string');
    if (!content) throw new Error('invalid odt');
    // Basic XML to text conversion
    const text = content
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { markdown: text, html: text };
  } catch (e) {
    throw badRequest('odt parsing failed: ' + e.message);
  }
}

async function parseFile(buffer, filename, mimeType) {
  if (buffer.length > MAX_FILE_BYTES) {
    throw badRequest(`file too large (max ${MAX_FILE_BYTES} bytes)`);
  }
  
  const ext = getExtension(filename) || mimeToExt(mimeType) || '';
  const metadata = { fileName: filename, fileType: ext };
  
  try {
    if (ext === 'pdf') {
      const data = await pdfParse(buffer);
      metadata.pageCount = data.numpages;
      metadata.title = data.info?.Title;
      return {
        markdown: data.text,
        html: `<pre>${data.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
        metadata
      };
    } else if (ext === 'docx' || ext === 'doc') {
      const result = await mammoth.extractRawText({ buffer });
      if (result.messages?.length) {
        // ignore warnings
      }
      return {
        markdown: result.value,
        html: result.value.replace(/\n/g, '<br>'),
        metadata
      };
    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      let markdown = '';
      let html = '<html><body>';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = xlsx.utils.sheet_to_csv(sheet);
        const htmlTable = xlsx.utils.sheet_to_html(sheet);
        markdown += `## ${sheetName}\n\n${csv}\n\n`;
        html += `<h2>${sheetName}</h2>${htmlTable}`;
      }
      html += '</body></html>';
      metadata.sheetCount = workbook.SheetNames.length;
      return { markdown, html, metadata };
    } else if (ext === 'rtf') {
      const result = await parseRTF(buffer);
      return { ...result, metadata };
    } else if (ext === 'odt' || ext === 'ods') {
      const result = await parseODT(buffer);
      return { ...result, metadata };
    } else {
      throw badRequest(`unsupported file type: ${ext || mimeType || 'unknown'}. Supported: pdf, docx, xlsx, xls, odt, rtf`);
    }
  } catch (e) {
    if (e.status) throw e;
    throw badRequest('failed to parse file: ' + e.message);
  }
}

export async function v2Parse(body = {}, request, config = {}) {
  let buffer = null;
  let filename = 'file';
  let mimeType = '';
  
  const contentType = request.headers['content-type'] || '';
  
  if (contentType.includes('multipart/form-data')) {
    // Need to read raw body
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      request.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          request.destroy();
          reject(badRequest('file too large'));
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', resolve);
      request.on('error', reject);
    });
    const raw = Buffer.concat(chunks);
    const parsed = await parseMultipart(raw, contentType);
    buffer = parsed.buffer;
    filename = parsed.filename;
  } else if (typeof body === 'object' && body) {
    if (body.base64) {
      buffer = Buffer.from(body.base64, 'base64');
      filename = body.filename || body.name || 'file';
      mimeType = body.mimeType || '';
    } else if (body.file) {
      // Could be base64 in file
      if (typeof body.file === 'string') {
        buffer = Buffer.from(body.file, 'base64');
      } else if (body.file.data) {
        buffer = Buffer.from(body.file.data, 'base64');
      }
      filename = body.filename || body.name || 'file';
    } else if (body.url) {
      const url = String(body.url);
      // Check if it's a local file URL or needs fetching
      try {
        const parsed = parseUrlSafe(url);
        await assertPublicHost(parsed);
        const result = await fetchDocument(url, { mode: 'raw' }, config);
        buffer = Buffer.from(result.document.raw || result.document.text || '', 'utf8');
        filename = path.basename(parsed.pathname) || 'file';
      } catch (e) {
        if (e.status) throw e;
        // Try as file path
        if (fs.existsSync(url)) {
          buffer = fs.readFileSync(url);
          filename = path.basename(url);
        } else {
          throw badRequest('could not fetch file from url: ' + e.message);
        }
      }
    }
  }
  
  if (!buffer) {
    throw badRequest('no file provided. Use multipart/form-data with file field, or JSON with base64/filename or url');
  }
  
  const result = await parseFile(buffer, filename, mimeType);
  
  return {
    success: true,
    data: {
      markdown: result.markdown,
      html: result.html,
      metadata: result.metadata
    }
  };
}
