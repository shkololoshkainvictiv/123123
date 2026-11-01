const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  sanitizeReportFileName,
  computeMd5,
  validateXlsxBuffer,
  listXlsxReports,
  rewriteOkkamLinks,
  resolveUploadTargets
} = require('./lib/backendLogic');
const {
  ALL_SECTIONS,
  getDesktopUpdateStatus,
  buildWindowsLauncherBat,
  AccountStore
} = require('./lib/authStore');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;

const accountStore = new AccountStore(path.join(ROOT_DIR, 'data', 'accounts.json'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});

// Middleware for CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Accept-Language');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Raw binary parser specifically for /zakaz/save.php
app.post(
  '/zakaz/save.php',
  express.raw({ type: '*/*', limit: '30mb' }),
  (req, res) => {
    try {
      const body = req.body;
      if (Buffer.isBuffer(body) && body.length > 0) {
        const target = path.join(ROOT_DIR, 'zakaz', 'zakaz.xlsx');
        fs.writeFileSync(target, body);
        return res.status(200).type('text/plain').send('Success');
      }
      return res.status(400).type('text/plain').send('Error');
    } catch (err) {
      return res.status(500).type('text/plain').send('Error');
    }
  }
);

// Standard JSON & URL-encoded body parsers for other routes
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));

// Helper to extract bearer or cookie token
function extractAuthToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.match(/(?:^|;\s*)okkam_token=([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return '';
}

function requireAdmin(req, res, next) {
  const token = extractAuthToken(req);
  const acc = accountStore.getAccountByToken(token);
  if (!acc) {
    return res.status(401).json({ ok: false, error: 'Требуется авторизация' });
  }
  if (acc.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Недостаточно прав (требуется роль Администратор)' });
  }
  req.currentAccount = acc;
  next();
}

// ============================================================================
// Auth & Admin Panel API Routes
// ============================================================================

app.get('/api/auth/me', (req, res) => {
  const token = extractAuthToken(req);
  const acc = accountStore.getAccountByToken(token);
  return res.json({
    ok: true,
    authenticated: Boolean(acc),
    account: acc,
    sections: ALL_SECTIONS
  });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body || {};
  const result = accountStore.authenticateCredentials(login, password);
  if (!result.ok) {
    return res.status(401).json(result);
  }
  return res.json(result);
});

app.post('/api/auth/google', (req, res) => {
  const { uid, email, displayName } = req.body || {};
  const result = accountStore.authenticateGoogleUser({ uid, email, displayName });
  if (!result.ok) {
    return res.status(403).json(result);
  }
  return res.json(result);
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractAuthToken(req);
  accountStore.revokeToken(token);
  return res.json({ ok: true });
});

app.get('/api/accounts', requireAdmin, (req, res) => {
  return res.json({
    ok: true,
    accounts: accountStore.listAccounts(),
    sections: ALL_SECTIONS
  });
});

app.post('/api/accounts', requireAdmin, (req, res) => {
  const result = accountStore.createAccount(req.body || {});
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

app.put('/api/accounts/:id', requireAdmin, (req, res) => {
  const result = accountStore.updateAccount(req.params.id, req.body || {});
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

app.delete('/api/accounts/:id', requireAdmin, (req, res) => {
  const result = accountStore.deleteAccount(req.params.id, req.currentAccount.id);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

app.get('/api/desktop/update-check', (req, res) => {
  return res.json(getDesktopUpdateStatus());
});

app.get('/api/desktop/shortcut.bat', (req, res) => {
  const clientOrigin = String(req.query.origin || '').trim();
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  const appUrl =
    clientOrigin && /^https?:\/\//i.test(clientOrigin)
      ? clientOrigin
      : `${proto}://${host}/`;
  const userAgent = req.query.ua || req.headers['user-agent'] || '';
  const batContent = buildWindowsLauncherBat(appUrl, userAgent);
  res.setHeader('Content-Type', 'application/x-bat; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="OKKAM_Desktop.bat"');
  return res.send(batContent);
});

// ============================================================================
// Legacy PHP Endpoints (Migrated to Express)
// ============================================================================

// 1. /ip.php
app.get('/ip.php', (req, res) => {
  const remoteAddr = req.socket?.remoteAddress || req.ip || '127.0.0.1';
  const xRealIp = req.headers['x-real-ip'] || 'Не используется';
  const xForwardedFor = req.headers['x-forwarded-for'] || 'Не используется';
  res
    .status(200)
    .type('text/html; charset=utf-8')
    .send(
      `1. Remote_Addr (обычный IP): ${remoteAddr}<br>` +
      `2. X-Real-IP: ${xRealIp}<br>` +
      `3. X-Forwarded-For: ${xForwardedFor}<br>`
    );
});

// 2. UTrace API handler for /gtin/api.php, /tsd/api.php, /zapros/api.php
let cachedUtraceToken = null;
const UTRACE_API_BASE = 'https://multon-goods-ru.utrace.cloud/api/stock';
const UTRACE_AUTH_URL = 'https://multon-goods-ru.utrace.cloud/auth/api/auth?locale=ru-RU';

async function getUtraceToken() {
  if (cachedUtraceToken) return cachedUtraceToken;

  const login = process.env.UTRACE_LOGIN || 'RF120267';
  const password = process.env.UTRACE_PASSWORD || '123456MIX';

  const res = await fetch(UTRACE_AUTH_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ login, password })
  });

  const text = await res.text();
  if (res.ok) {
    try {
      const data = JSON.parse(text);
      cachedUtraceToken = data.token || data.access_token || text;
    } catch {
      cachedUtraceToken = text;
    }
    return cachedUtraceToken;
  }
  throw new Error(`Auth Failed: ${res.status}`);
}

async function handleUtraceApi(req, res) {
  const action = req.query.action || '';
  const input = req.body || {};

  try {
    if (action === 'reserve') {
      const token = await getUtraceToken();
      const response = await fetch(`${UTRACE_API_BASE}/reserve`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: token
        },
        body: JSON.stringify({
          gtin: input.gtin,
          productionSite: '3942',
          count: parseInt(input.count, 10) || 1
        })
      });
      const bodyText = await response.text();
      if (response.status !== 200) {
        if (response.status === 401) cachedUtraceToken = null;
        throw new Error(`Reserve Error ${response.status}: ${bodyText}`);
      }
      res.type('application/json').send(bodyText);
      return;
    }

    if (action === 'export') {
      const token = await getUtraceToken();
      const reserveId = encodeURIComponent(req.query.reserveId || '');
      const response = await fetch(
        `${UTRACE_API_BASE}/codes/export?reserveId=${reserveId}&format=xlsx`,
        {
          method: 'GET',
          headers: { authorization: token }
        }
      );
      if (response.status !== 200) {
        throw new Error(`Export Error ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="codes.xlsx"');
      res.send(Buffer.from(arrayBuffer));
      return;
    }

    if (action === 'receive') {
      const token = await getUtraceToken();
      const response = await fetch(`${UTRACE_API_BASE}/receive`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: token
        },
        body: JSON.stringify({ reserveId: input.reserveId })
      });
      if (response.status !== 200) {
        throw new Error(`Receive Error ${response.status}`);
      }
      res.json({ success: true });
      return;
    }

    throw new Error('Invalid action');
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}

app.all('/gtin/api.php', handleUtraceApi);
app.all('/tsd/api.php', handleUtraceApi);
app.all('/zapros/api.php', handleUtraceApi);

// 3. /hd/report.php and /hd/report1.php
function handleHdReport(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  const hdDir = path.join(ROOT_DIR, 'hd');
  const reportFile = path.join(hdDir, 'problem.xlsx');
  const prevFile = path.join(hdDir, 'problem.prev.xlsx');

  if (req.method === 'GET') {
    if (!fs.existsSync(reportFile)) {
      return res.status(200).json({ success: true, exists: false, version: 'none' });
    }
    try {
      const bin = fs.readFileSync(reportFile);
      return res.status(200).json({
        success: true,
        exists: true,
        version: computeMd5(bin),
        data: bin.toString('base64')
      });
    } catch {
      return res.status(500).json({ success: false, error: 'Не удалось прочитать problem.xlsx' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Метод не поддерживается' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || body.data === undefined || body.base === undefined) {
    return res.status(400).json({ success: false, error: 'Неверный запрос' });
  }

  const bin = Buffer.from(String(body.data), 'base64');
  const validation = validateXlsxBuffer(bin);
  if (!validation.ok) {
    return res.status(validation.status).json({ success: false, error: validation.error });
  }

  const currentVersion = fs.existsSync(reportFile)
    ? computeMd5(fs.readFileSync(reportFile))
    : 'none';

  if (String(body.base) !== currentVersion) {
    return res.status(409).json({
      success: false,
      conflict: true,
      version: currentVersion
    });
  }

  try {
    if (fs.existsSync(reportFile)) {
      fs.copyFileSync(reportFile, prevFile);
    }
    fs.writeFileSync(reportFile, bin);
    return res.status(200).json({ success: true, version: computeMd5(bin) });
  } catch {
    return res.status(500).json({ success: false, error: 'Не удалось заменить problem.xlsx' });
  }
}

app.all('/hd/report.php', handleHdReport);
app.all('/hd/report1.php', handleHdReport);

// 4. /hd/save_report.php
app.post('/hd/save_report.php', (req, res) => {
  const input = req.body;
  if (!input || typeof input !== 'object' || !input.name || !input.data) {
    return res.json({
      success: false,
      error: 'Отсутствуют обязательные параметры: name, data'
    });
  }

  const fileName = String(input.name);
  if (fileName.includes('..')) {
    return res.json({ success: false, error: 'Недопустимое имя файла' });
  }

  const binaryData = Buffer.from(String(input.data), 'base64');
  if (binaryData.length === 0) {
    return res.json({ success: false, error: 'Пустые данные файла' });
  }

  try {
    const fullPath = path.join(ROOT_DIR, 'hd', fileName);
    const targetDir = path.dirname(fullPath);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(fullPath, binaryData);
    return res.json({
      success: true,
      file: fileName,
      size: binaryData.length
    });
  } catch (err) {
    return res.json({ success: false, error: 'Не удалось записать файл на сервер' });
  }
});

// 5. /invent/list_reports.php
app.get('/invent/list_reports.php', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    const files = listXlsxReports(path.join(ROOT_DIR, 'invent'), ['ostatok.xlsx']);
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 6. /invent/save_report.php
app.post('/invent/save_report.php', (req, res) => {
  const input = req.body;
  if (!input || !input.name || !input.data) {
    return res.status(400).json({ success: false, error: 'Invalid data' });
  }

  const { valid, fileName } = sanitizeReportFileName(input.name, true);
  if (!valid) {
    return res
      .status(400)
      .json({ success: false, error: 'Invalid filename characters: ' + fileName });
  }

  try {
    const data = Buffer.from(String(input.data), 'base64');
    if (data.length === 0) {
      throw new Error('Empty file data');
    }
    const filePath = path.join(ROOT_DIR, 'invent', fileName);
    fs.writeFileSync(filePath, data);
    return res.json({
      success: true,
      filename: fileName,
      size: data.length
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 7. /invent/delete_report.php
app.post('/invent/delete_report.php', (req, res) => {
  const input = req.body;
  if (!input || !input.name) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  const { valid, fileName } = sanitizeReportFileName(input.name, true);
  if (!valid) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(ROOT_DIR, 'invent', fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    fs.unlinkSync(filePath);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to delete file' });
  }
});

// 8. /perco/list_reports.php
app.get('/perco/list_reports.php', (req, res) => {
  try {
    const files = listXlsxReports(path.join(ROOT_DIR, 'perco'), []);
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 9. /perco/delete_report.php
app.post('/perco/delete_report.php', (req, res) => {
  const input = req.body;
  if (!input || !input.name) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  const { valid, fileName } = sanitizeReportFileName(input.name, true);
  if (!valid) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(ROOT_DIR, 'perco', fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    fs.unlinkSync(filePath);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'Failed to delete file' });
  }
});

// 10. /perco/proxy.php
app.all('/perco/proxy.php', async (req, res) => {
  const percoHost = (process.env.PERCO_HOST || 'http://srv-perco1').replace(/\/+$/, '');
  const targetUrl = String(req.query.url || '').replace(/^\/+/, '');

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const url = `${percoHost}/${targetUrl}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const fetchOpts = {
      method: req.method,
      headers: {
        Host: 'srv-perco1',
        Accept: req.headers['accept'] || '*/*'
      },
      signal: controller.signal
    };
    if (req.method === 'POST' && req.body) {
      fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      fetchOpts.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    }
    const response = await fetch(url, fetchOpts);
    clearTimeout(timeout);
    const text = await response.text();
    res.status(response.status).type('application/json').send(text);
  } catch (err) {
    res.status(502).json({
      error: 'Proxy connection failed',
      curl_error: err.message,
      target_url: url,
      note: 'Сервер srv-perco1 недоступен из интернета. Запустите этот скрипт локально.'
    });
  }
});

// 11. /panel/upload.php
app.post('/panel/upload.php', upload.single('file'), (req, res) => {
  const type = req.body?.type || '';
  const file = req.file;

  if (!file) {
    return res.json({ success: false, message: 'Ошибка загрузки файла на сервер' });
  }

  const ext = path.extname(file.originalname).replace(/^\./, '').toLowerCase();
  const targetInfo = resolveUploadTargets(ROOT_DIR, type, ext);

  if (!targetInfo.valid) {
    return res.json({ success: false, message: targetInfo.message });
  }

  const errors = [];
  for (const dir of targetInfo.targetDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, targetInfo.fileName), file.buffer);
    } catch {
      errors.push(path.basename(dir));
    }
  }

  if (errors.length === 0) {
    const msg =
      type === 'ostatok'
        ? 'Остатки перезаписаны в 4 директориях'
        : 'Табель перезаписан в 2 директориях';
    return res.json({ success: true, message: msg });
  }

  return res.json({
    success: false,
    message: 'Ошибка перезаписи в: ' + errors.join(', ')
  });
});

// Intercept HTML requests to rewrite hardcoded http(s)://okkam.space links and inject auth-bundle.js
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  const reqPath = decodeURIComponent(req.path);
  if (reqPath.includes('..')) {
    return next();
  }

  let candidatePath = path.join(ROOT_DIR, reqPath);

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
    if (!req.path.endsWith('/')) {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      return res.redirect(301, req.path + '/' + query);
    }
    candidatePath = path.join(candidatePath, 'index.html');
  }

  if (
    candidatePath.endsWith('.html') &&
    fs.existsSync(candidatePath) &&
    fs.statSync(candidatePath).isFile()
  ) {
    try {
      const rawHtml = fs.readFileSync(candidatePath, 'utf-8');
      let rewrittenHtml = rewriteOkkamLinks(rawHtml);
      if (!rewrittenHtml.includes('manifest.json') && rewrittenHtml.includes('</head>')) {
        rewrittenHtml = rewrittenHtml.replace(
          '</head>',
          '<link rel="manifest" href="/manifest.json">\n</head>'
        );
      }
      if (!rewrittenHtml.includes('/auth-bundle.js')) {
        if (rewrittenHtml.includes('</body>')) {
          rewrittenHtml = rewrittenHtml.replace(
            '</body>',
            '<script src="/auth-bundle.js" defer></script>\n</body>'
          );
        } else {
          rewrittenHtml += '\n<script src="/auth-bundle.js" defer></script>';
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(rewrittenHtml);
    } catch {
      return next();
    }
  }

  next();
});

// Static files middleware
app.use(express.static(ROOT_DIR));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OKKAM server running at http://0.0.0.0:${PORT}`);
});
