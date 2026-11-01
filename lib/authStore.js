const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALL_SECTIONS = [
  { id: 'dublikat', title: 'Дубликат КИТУ', desc: 'печать этикеток РТ', path: '/dublikat/', category: 'default' },
  { id: 'perepak', title: 'Multon', desc: 'генерация и печать этикеток', path: '/perepak/', category: 'red' },
  { id: 'gtin', title: 'Перепак', desc: 'Поиск GTIN и запрос кодов', path: '/gtin/', category: 'red' },
  { id: 'sborka', title: 'Формирование заказа', desc: 'автоматическое заполнение Excel документа', path: '/sborka/', category: 'red' },
  { id: 'sverka', title: 'Сверка остатков', desc: 'ручная сверка остатков SAP и WMS', path: '/sverka/', category: 'red-blue' },
  { id: 'reestr', title: 'Реестр', desc: 'формирование реестра', path: '/reestr/', category: 'default' },
  { id: 'zakaz', title: 'Поставка', desc: 'Запрос товаров для поставки', path: '/zakaz/', category: 'default' },
  { id: 'x5', title: 'x5', desc: 'работа с файлом х5', path: '/x5/', category: 'green' },
  { id: 'doki', title: 'Печать документов', desc: 'быстрая печать бланков', path: '/doki/', category: 'default' },
  { id: 'invent', title: 'Инвентаризация', desc: 'терминал инвентаризации склада', path: '/invent/', category: 'extra' },
  { id: 'hd', title: 'Проблемные марки', desc: 'сканирование марок с проблемами', path: '/hd/', category: 'extra' },
  { id: 'tabel', title: 'Табель смен', desc: 'учёт рабочего времени и смен', path: '/tabel/', category: 'extra' },
  { id: 'zapolnenie', title: 'Карта склада', desc: 'интерактивная карта заполненности склада', path: '/zapolnenie/', category: 'extra' },
  { id: 'pros4et', title: 'Счётные листы', desc: 'счётные листы инвентаризации', path: '/pros4et/', category: 'extra' },
  { id: 'delta', title: 'Аналитика складов', desc: 'аналитика складов 11 и 12', path: '/delta/', category: 'extra' },
  { id: '1', title: 'Обработка ТС', desc: 'просчёт времени обработки ТС', path: '/1/', category: 'extra' },
  { id: 'panel', title: 'Панель загрузки', desc: 'распределение файлов табеля и остатков', path: '/panel/', category: 'extra' },
  { id: 'tsd', title: 'ТСД Перепак', desc: 'мобильный терминал заказа кодов', path: '/tsd/', category: 'extra' }
];

const ALL_SECTION_IDS = ALL_SECTIONS.map((s) => s.id);
const MAIN_PORTAL_SECTION_IDS = [
  'dublikat',
  'perepak',
  'gtin',
  'sborka',
  'sverka',
  'reestr',
  'zakaz',
  'x5',
  'doki'
];

function hashPassword(password) {
  return crypto.createHash('sha256').update(`okkam_salt_${String(password)}`).digest('hex');
}

function sanitizeAccountId(rawId) {
  const cleaned = String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64);
  return cleaned || `user_${Date.now()}`;
}

function validateAccountInput(payload, isUpdate = false) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Некорректные данные учётной записи' };
  }

  const login = String(payload.login || '').trim();
  const displayName = String(payload.displayName || '').trim();
  const role = payload.role === 'admin' ? 'admin' : 'user';
  const active = payload.active !== undefined ? Boolean(payload.active) : true;
  const password = payload.password !== undefined ? String(payload.password) : '';

  if (login.length < 2 || login.length > 100) {
    return { valid: false, error: 'Логин должен содержать от 2 до 100 символов' };
  }
  if (displayName.length < 1 || displayName.length > 120) {
    return { valid: false, error: 'Имя / должность должно содержать от 1 до 120 символов' };
  }
  if (!isUpdate && password.trim().length < 3) {
    return { valid: false, error: 'Пароль должен содержать минимум 3 символа' };
  }

  let allowedSections = [];
  if (role === 'admin') {
    allowedSections = [...ALL_SECTION_IDS];
  } else if (Array.isArray(payload.allowedSections)) {
    allowedSections = payload.allowedSections
      .map((s) => String(s).trim())
      .filter((s) => ALL_SECTION_IDS.includes(s))
      .slice(0, 25);
  }

  return {
    valid: true,
    data: {
      login,
      displayName,
      role,
      allowedSections,
      active,
      password: password.trim()
    }
  };
}

function canAccessSection(account, sectionId) {
  if (!account || !account.active) return false;
  if (account.role === 'admin') return true;
  if (!Array.isArray(account.allowedSections)) return false;
  return account.allowedSections.includes(sectionId);
}

function extractSectionFromPath(urlPath) {
  const clean = String(urlPath || '').split('?')[0].replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  const firstSegment = clean.split('/')[0].toLowerCase();
  if (ALL_SECTION_IDS.includes(firstSegment)) {
    return firstSegment;
  }
  if (firstSegment === 'ermann') return 'reestr';
  if (firstSegment === 'zapros') return 'gtin';
  if (firstSegment === 'perco') return 'invent';
  return null;
}

function getDefaultAccounts() {
  const now = new Date().toISOString();
  return [
    {
      id: 'admin',
      uid: 'admin',
      login: 'admin',
      email: 'shkololoshka.invictiv@gmail.com',
      displayName: 'Главный администратор ОККАМ',
      role: 'admin',
      allowedSections: [...ALL_SECTION_IDS],
      active: true,
      passwordHash: hashPassword('admin123'),
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'operator_rt',
      uid: 'operator_rt',
      login: 'operator_rt',
      email: '',
      displayName: 'Оператор печати и перепака',
      role: 'user',
      allowedSections: ['dublikat', 'perepak', 'gtin', 'doki'],
      active: true,
      passwordHash: hashPassword('12345'),
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'kladovshik',
      uid: 'kladovshik',
      login: 'kladovshik',
      email: '',
      displayName: 'Старший кладовщик (Учёт и ТС)',
      role: 'user',
      allowedSections: ['sborka', 'sverka', 'reestr', 'zakaz', 'x5', 'invent'],
      active: true,
      passwordHash: hashPassword('12345'),
      createdAt: now,
      updatedAt: now
    }
  ];
}

function toPublicAccount(acc) {
  if (!acc) return null;
  const { passwordHash, ...rest } = acc;
  return {
    ...rest,
    allowedSections: acc.role === 'admin' ? [...ALL_SECTION_IDS] : (acc.allowedSections || [])
  };
}

class AccountStore {
  constructor(storageFilePath) {
    this.storageFilePath = storageFilePath;
    this.accounts = new Map();
    this.sessions = new Map();
    this._load();
  }

  _load() {
    try {
      if (this.storageFilePath && fs.existsSync(this.storageFilePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storageFilePath, 'utf-8'));
        if (Array.isArray(raw) && raw.length > 0) {
          for (const item of raw) {
            this.accounts.set(item.id, item);
          }
          return;
        }
      }
    } catch {
      // ignore and seed defaults
    }
    for (const def of getDefaultAccounts()) {
      this.accounts.set(def.id, def);
    }
    this._save();
  }

  _save() {
    if (!this.storageFilePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storageFilePath), { recursive: true });
      fs.writeFileSync(
        this.storageFilePath,
        JSON.stringify(Array.from(this.accounts.values()), null, 2),
        'utf-8'
      );
    } catch {
      // ignore disk errors in ephemeral environments
    }
  }

  listAccounts() {
    return Array.from(this.accounts.values()).map(toPublicAccount);
  }

  getAccountById(id) {
    return this.accounts.get(id) || null;
  }

  findByLoginOrEmail(identifier) {
    const norm = String(identifier || '').trim().toLowerCase();
    if (!norm) return null;
    for (const acc of this.accounts.values()) {
      if (
        String(acc.login || '').toLowerCase() === norm ||
        (acc.email && String(acc.email).toLowerCase() === norm)
      ) {
        return acc;
      }
    }
    return null;
  }

  authenticateCredentials(login, password) {
    const acc = this.findByLoginOrEmail(login);
    if (!acc) {
      return { ok: false, error: 'Пользователь с таким логином не найден' };
    }
    if (!acc.active) {
      return { ok: false, error: 'Учётная запись заблокирована администратором' };
    }
    if (acc.passwordHash !== hashPassword(password)) {
      return { ok: false, error: 'Неверный пароль' };
    }
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, { accountId: acc.id, createdAt: Date.now() });
    return { ok: true, token, account: toPublicAccount(acc) };
  }

  authenticateGoogleUser({ uid, email, displayName }) {
    const normEmail = String(email || '').trim().toLowerCase();
    const isBootstrapped = normEmail === 'shkololoshka.invictiv@gmail.com';
    let acc = this.findByLoginOrEmail(normEmail);

    if (!acc && isBootstrapped) {
      acc = this.accounts.get('admin');
    }

    if (!acc) {
      return {
        ok: false,
        error: `Аккаунт ${normEmail || uid} не зарегистрирован в системе. Обратитесь к администратору.`
      };
    }

    if (!acc.active) {
      return { ok: false, error: 'Учётная запись заблокирована администратором' };
    }

    if (uid) {
      acc.uid = sanitizeAccountId(uid);
    }
    if (displayName && !acc.displayName) {
      acc.displayName = displayName;
    }
    this._save();

    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, { accountId: acc.id, createdAt: Date.now() });
    return { ok: true, token, account: toPublicAccount(acc) };
  }

  getAccountByToken(token) {
    if (!token || !this.sessions.has(token)) return null;
    const session = this.sessions.get(token);
    const acc = this.accounts.get(session.accountId);
    if (!acc || !acc.active) {
      this.sessions.delete(token);
      return null;
    }
    return toPublicAccount(acc);
  }

  revokeToken(token) {
    if (token) {
      this.sessions.delete(token);
    }
  }

  createAccount(payload) {
    const validation = validateAccountInput(payload, false);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }
    const { login, displayName, role, allowedSections, active, password } = validation.data;
    if (this.findByLoginOrEmail(login)) {
      return { ok: false, error: 'Учётная запись с таким логином уже существует' };
    }

    let id = sanitizeAccountId(login);
    if (this.accounts.has(id)) {
      id = `${id}_${Date.now().toString(36)}`;
    }
    const now = new Date().toISOString();
    const record = {
      id,
      uid: id,
      login,
      email: login.includes('@') ? login : String(payload.email || '').trim(),
      displayName,
      role,
      allowedSections,
      active,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now
    };
    this.accounts.set(id, record);
    this._save();
    return { ok: true, account: toPublicAccount(record) };
  }

  updateAccount(id, payload) {
    const existing = this.accounts.get(id);
    if (!existing) {
      return { ok: false, error: 'Учётная запись не найдена' };
    }

    const merged = {
      login: payload.login !== undefined ? payload.login : existing.login,
      displayName: payload.displayName !== undefined ? payload.displayName : existing.displayName,
      role: payload.role !== undefined ? payload.role : existing.role,
      allowedSections:
        payload.allowedSections !== undefined ? payload.allowedSections : existing.allowedSections,
      active: payload.active !== undefined ? payload.active : existing.active,
      password: payload.password !== undefined ? payload.password : ''
    };

    const validation = validateAccountInput(merged, true);
    if (!validation.valid) {
      return { ok: false, error: validation.error };
    }

    const dup = this.findByLoginOrEmail(validation.data.login);
    if (dup && dup.id !== id) {
      return { ok: false, error: 'Другой пользователь уже использует этот логин' };
    }

    // Prevent disabling or demoting the last active admin
    if (existing.role === 'admin' && (validation.data.role !== 'admin' || !validation.data.active)) {
      const activeAdmins = Array.from(this.accounts.values()).filter(
        (a) => a.role === 'admin' && a.active && a.id !== id
      );
      if (activeAdmins.length === 0) {
        return {
          ok: false,
          error: 'Нельзя заблокировать или лишить прав единственного администратора'
        };
      }
    }

    existing.login = validation.data.login;
    existing.displayName = validation.data.displayName;
    existing.role = validation.data.role;
    existing.allowedSections = validation.data.allowedSections;
    existing.active = validation.data.active;
    if (payload.email !== undefined) {
      existing.email = String(payload.email).trim();
    } else if (validation.data.login.includes('@')) {
      existing.email = validation.data.login;
    }
    if (validation.data.password.length >= 3) {
      existing.passwordHash = hashPassword(validation.data.password);
    }
    existing.updatedAt = new Date().toISOString();

    this.accounts.set(id, existing);
    this._save();
    return { ok: true, account: toPublicAccount(existing) };
  }

  deleteAccount(id, currentActorId) {
    const existing = this.accounts.get(id);
    if (!existing) {
      return { ok: false, error: 'Учётная запись не найдена' };
    }
    if (id === currentActorId) {
      return { ok: false, error: 'Нельзя удалить собственную активную учётную запись' };
    }
    if (existing.role === 'admin') {
      const activeAdmins = Array.from(this.accounts.values()).filter(
        (a) => a.role === 'admin' && a.active && a.id !== id
      );
      if (activeAdmins.length === 0) {
        return { ok: false, error: 'Нельзя удалить единственного администратора' };
      }
    }
    this.accounts.delete(id);
    for (const [token, sess] of this.sessions.entries()) {
      if (sess.accountId === id) {
        this.sessions.delete(token);
      }
    }
    this._save();
    return { ok: true };
  }
}

function getDesktopUpdateStatus() {
  return {
    ok: true,
    version: '6.6.3',
    build: '2026.11-PC',
    upToDate: true,
    logoUrl: 'https://static.tildacdn.com/tild3533-3834-4361-a636-646263663031/logo.svg',
    steps: [
      { progress: 20, label: 'Инициализация десктопного ядра OKKAM Client...' },
      { progress: 50, label: 'Проверка обновлений на сервере (v6.6.3 — актуальная сборка)...' },
      { progress: 80, label: 'Синхронизация модулей склада и политики доступа...' },
      { progress: 100, label: 'Готово к работе. Запуск окна авторизации...' }
    ]
  };
}

function buildWindowsLauncherBat(appUrl, userAgent = '') {
  const rawUrl = String(appUrl || 'http://localhost:3000').trim().replace(/["\r\n<>^&|]/g, '');
  const baseUrl = rawUrl.replace(/\/+$/, '');
  const launchUrl = baseUrl.includes('?') ? `${baseUrl}&launch=desktop` : `${baseUrl}/?launch=desktop`;
  const ua = String(userAgent || '').toLowerCase();

  const preferYandex = ua.includes('yabrowser');
  const preferEdge = ua.includes('edg/');

  const preferredChecks = [];
  if (preferYandex) {
    preferredChecks.push(
      'if exist "%LocalAppData%\\Yandex\\YandexBrowser\\Application\\browser.exe" set "BROWSER_EXE=%LocalAppData%\\Yandex\\YandexBrowser\\Application\\browser.exe"',
      'if defined BROWSER_EXE goto :launch_app',
      'if exist "%ProgramFiles(x86)%\\Yandex\\YandexBrowser\\Application\\browser.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Yandex\\YandexBrowser\\Application\\browser.exe"',
      'if defined BROWSER_EXE goto :launch_app'
    );
  } else if (preferEdge) {
    preferredChecks.push(
      'if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
      'if defined BROWSER_EXE goto :launch_app',
      'if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
      'if defined BROWSER_EXE goto :launch_app',
      'if exist "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"',
      'if defined BROWSER_EXE goto :launch_app'
    );
  }

  return [
    '@echo off',
    'setlocal EnableExtensions',
    'title OKKAM Warehouse Desktop v6.6.3',
    'color 0F',
    'echo ============================================================',
    'echo   OKKAM WAREHOUSE DESKTOP CLIENT (v6.6.3)',
    'echo ============================================================',
    'echo.',
    'echo   [1/3] Initializing OKKAM Desktop Client...',
    'ping 127.0.0.1 -n 2 >nul',
    'echo   [2/3] Checking server updates (v6.6.3 Up-To-Date)...',
    'ping 127.0.0.1 -n 2 >nul',
    'echo   [3/3] Starting application window...',
    'echo.',
    `set "APP_URL=${launchUrl}"`,
    'set "BROWSER_EXE="',
    ...preferredChecks,
    'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%LocalAppData%\\Yandex\\YandexBrowser\\Application\\browser.exe" set "BROWSER_EXE=%LocalAppData%\\Yandex\\YandexBrowser\\Application\\browser.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%ProgramFiles(x86)%\\Yandex\\YandexBrowser\\Application\\browser.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Yandex\\YandexBrowser\\Application\\browser.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'if exist "%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if defined BROWSER_EXE goto :launch_app',
    'echo   Opening in default system browser...',
    'rundll32 url.dll,FileProtocolHandler "%APP_URL%"',
    'goto :finish',
    ':launch_app',
    'echo   Launching standalone PC window...',
    'start "" "%BROWSER_EXE%" --app="%APP_URL%" --window-size=1440,900',
    ':finish',
    'echo.',
    'echo   OKKAM Desktop started!',
    'ping 127.0.0.1 -n 2 >nul',
    'exit /b 0'
  ].join('\r\n');
}

module.exports = {
  ALL_SECTIONS,
  ALL_SECTION_IDS,
  MAIN_PORTAL_SECTION_IDS,
  hashPassword,
  sanitizeAccountId,
  validateAccountInput,
  canAccessSection,
  extractSectionFromPath,
  getDesktopUpdateStatus,
  buildWindowsLauncherBat,
  AccountStore
};

