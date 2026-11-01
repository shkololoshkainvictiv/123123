const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Validates report filenames used by /invent and /perco endpoints.
 * @param {string} rawName
 * @param {boolean} allowTilde
 * @returns {{ valid: boolean, fileName: string }}
 */
function sanitizeReportFileName(rawName, allowTilde = true) {
  if (!rawName || typeof rawName !== 'string') {
    return { valid: false, fileName: '' };
  }
  const normalized = rawName.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  const pattern = allowTilde ? /^[a-zA-Z0-9_\-.~]+$/ : /^[a-zA-Z0-9_\-.]+$/;
  if (!base || base === '.' || base === '..' || !pattern.test(base)) {
    return { valid: false, fileName: base };
  }
  return { valid: true, fileName: base };
}

/**
 * Computes MD5 hex digest of a Buffer.
 * @param {Buffer} buffer
 * @returns {string}
 */
function computeMd5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Validates that a buffer looks like a valid XLSX (ZIP/PK header) file.
 * @param {Buffer} buffer
 * @param {number} maxBytes
 * @returns {{ ok: boolean, status?: number, error?: string }}
 */
function validateXlsxBuffer(buffer, maxBytes = 30 * 1024 * 1024) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || buffer.slice(0, 2).toString('ascii') !== 'PK') {
    return { ok: false, status: 400, error: 'Данные не похожи на xlsx-файл' };
  }
  if (buffer.length > maxBytes) {
    return { ok: false, status: 413, error: 'Файл слишком большой' };
  }
  return { ok: true };
}

/**
 * Lists .xlsx report files in a directory sorted by lastModified descending.
 * @param {string} dirPath
 * @param {string[]} excludeNames
 * @returns {Array<{ name: string, size: number, lastModified: number }>}
 */
function listXlsxReports(dirPath, excludeNames = []) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const excludeLower = new Set(excludeNames.map((n) => n.toLowerCase()));
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.xlsx') continue;
    if (excludeLower.has(entry.name.toLowerCase())) continue;

    const fullPath = path.join(dirPath, entry.name);
    const stat = fs.statSync(fullPath);
    files.push({
      name: entry.name,
      size: stat.size,
      lastModified: Math.floor(stat.mtimeMs / 1000)
    });
  }

  files.sort((a, b) => b.lastModified - a.lastModified);
  return files;
}

/**
 * Rewrites absolute okkam.space URLs in HTML content to local root-relative paths
 * so navigation works seamlessly inside the local/cloud container environment.
 * @param {string} html
 * @returns {string}
 */
function rewriteOkkamLinks(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/https?:\/\/okkam\.space\/([a-zA-Z0-9_-]+)\/?/g, '/$1/')
    .replace(/https?:\/\/okkam\.space\/?/g, '/');
}

/**
 * Resolves target directories for /panel/upload.php based on upload type.
 * @param {string} baseDir
 * @param {string} type
 * @param {string} ext
 * @returns {{ valid: boolean, fileName?: string, targetDirs?: string[], message?: string }}
 */
function resolveUploadTargets(baseDir, type, ext) {
  const cleanExt = String(ext || '').replace(/^\./, '').toLowerCase();
  const allowedExts = ['xlsx', 'xls', 'csv', 'ods'];
  if (!allowedExts.includes(cleanExt)) {
    return { valid: false, message: 'Разрешены только форматы: xlsx, xls, csv, ods' };
  }

  if (type === 'ostatok') {
    return {
      valid: true,
      fileName: `ostatok.${cleanExt}`,
      targetDirs: [
        path.join(baseDir, 'invent'),
        path.join(baseDir, 'zapolnenie'),
        path.join(baseDir, 'zapolnenie1'),
        path.join(baseDir, 'pros4et')
      ]
    };
  }

  if (type === 'tabel') {
    return {
      valid: true,
      fileName: `tabel.${cleanExt}`,
      targetDirs: [
        path.join(baseDir, 'tabel'),
        path.join(baseDir, 'tabel1')
      ]
    };
  }

  return { valid: false, message: 'Неверный тип файла' };
}

module.exports = {
  sanitizeReportFileName,
  computeMd5,
  validateXlsxBuffer,
  listXlsxReports,
  rewriteOkkamLinks,
  resolveUploadTargets
};
