const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  sanitizeReportFileName,
  computeMd5,
  validateXlsxBuffer,
  listXlsxReports,
  rewriteOkkamLinks,
  resolveUploadTargets
} = require('./backendLogic');

test('sanitizeReportFileName accepts valid report names and blocks traversal', () => {
  const valid = sanitizeReportFileName('Sklad11__Ryady_1-2~16__Yarus_A-B__17-36-49.xlsx', true);
  assert.equal(valid.valid, true);
  assert.equal(valid.fileName, 'Sklad11__Ryady_1-2~16__Yarus_A-B__17-36-49.xlsx');

  const strippedPath = sanitizeReportFileName('../secret/report_01.xlsx', false);
  assert.equal(strippedPath.valid, true);
  assert.equal(strippedPath.fileName, 'report_01.xlsx');

  const invalidChars = sanitizeReportFileName('bad file$name.xlsx', true);
  assert.equal(invalidChars.valid, false);
});

test('validateXlsxBuffer checks PK header and minimum length', () => {
  const shortBuf = Buffer.from('PK123');
  assert.equal(validateXlsxBuffer(shortBuf).ok, false);

  const nonPkBuf = Buffer.alloc(150, 'A');
  assert.equal(validateXlsxBuffer(nonPkBuf).ok, false);

  const validBuf = Buffer.alloc(150, 0);
  validBuf.write('PK', 0, 'ascii');
  assert.equal(validateXlsxBuffer(validBuf).ok, true);
  assert.equal(computeMd5(validBuf).length, 32);
});

test('rewriteOkkamLinks converts absolute okkam.space links to root-relative paths', () => {
  const sample = '<a href="http://okkam.space" class="back-btn"></a><a href="http://okkam.space/dublikat"></a><a href="https://okkam.space/x5"></a>';
  const rewritten = rewriteOkkamLinks(sample);
  assert.equal(
    rewritten,
    '<a href="/" class="back-btn"></a><a href="/dublikat/"></a><a href="/x5/"></a>'
  );
});

test('resolveUploadTargets maps ostatok and tabel uploads to expected directories', () => {
  const ostatok = resolveUploadTargets('/app', 'ostatok', 'xlsx');
  assert.equal(ostatok.valid, true);
  assert.equal(ostatok.fileName, 'ostatok.xlsx');
  assert.equal(ostatok.targetDirs.length, 4);

  const tabel = resolveUploadTargets('/app', 'tabel', 'xls');
  assert.equal(tabel.valid, true);
  assert.equal(tabel.fileName, 'tabel.xls');
  assert.equal(tabel.targetDirs.length, 2);

  const badExt = resolveUploadTargets('/app', 'ostatok', 'exe');
  assert.equal(badExt.valid, false);
});

test('listXlsxReports lists .xlsx files in /invent excluding ostatok.xlsx', () => {
  const inventDir = path.resolve(__dirname, '..', 'invent');
  const reports = listXlsxReports(inventDir, ['ostatok.xlsx']);
  assert.ok(Array.isArray(reports));
  assert.ok(reports.length > 0);
  assert.ok(!reports.some((r) => r.name.toLowerCase() === 'ostatok.xlsx'));
});

const {
  AccountStore,
  canAccessSection,
  extractSectionFromPath,
  getDesktopUpdateStatus,
  buildWindowsLauncherBat
} = require('./authStore');

test('AccountStore authenticates, creates, updates, and enforces section access', () => {
  const store = new AccountStore(null);

  // Default admin login
  const adminRes = store.authenticateCredentials('admin', 'admin123');
  assert.equal(adminRes.ok, true);
  assert.equal(adminRes.account.role, 'admin');
  assert.equal(canAccessSection(adminRes.account, 'sverka'), true);
  assert.equal(canAccessSection(adminRes.account, 'dublikat'), true);

  // Create custom restricted user
  const createRes = store.createAccount({
    login: 'petrov_p',
    displayName: 'Петров П.П. (Сборка)',
    password: 'secret123',
    role: 'user',
    allowedSections: ['sborka', 'zakaz'],
    active: true
  });
  assert.equal(createRes.ok, true);
  assert.equal(createRes.account.login, 'petrov_p');
  assert.deepEqual(createRes.account.allowedSections, ['sborka', 'zakaz']);

  // Check section permissions for restricted user
  assert.equal(canAccessSection(createRes.account, 'sborka'), true);
  assert.equal(canAccessSection(createRes.account, 'zakaz'), true);
  assert.equal(canAccessSection(createRes.account, 'sverka'), false);
  assert.equal(canAccessSection(createRes.account, 'dublikat'), false);

  // Update allowed sections
  const updateRes = store.updateAccount(createRes.account.id, {
    allowedSections: ['sborka', 'zakaz', 'sverka']
  });
  assert.equal(updateRes.ok, true);
  assert.equal(canAccessSection(updateRes.account, 'sverka'), true);

  // Extract section slug from URL path
  assert.equal(extractSectionFromPath('/dublikat/index.html'), 'dublikat');
  assert.equal(extractSectionFromPath('/sverka/'), 'sverka');
  assert.equal(extractSectionFromPath('/'), null);
});

test('getDesktopUpdateStatus and buildWindowsLauncherBat generate valid PC desktop configuration', () => {
  const status = getDesktopUpdateStatus();
  assert.equal(status.ok, true);
  assert.equal(status.upToDate, true);
  assert.equal(
    status.logoUrl,
    'https://static.tildacdn.com/tild3533-3834-4361-a636-646263663031/logo.svg'
  );
  assert.equal(status.steps.length, 4);

  const bat = buildWindowsLauncherBat('https://example.com', 'Mozilla/5.0 Chrome/120.0');
  assert.ok(bat.includes('--app="%APP_URL%"'));
  assert.ok(bat.includes('set "APP_URL=https://example.com/?launch=desktop"'));
  assert.ok(bat.includes('rundll32 url.dll,FileProtocolHandler "%APP_URL%"'));
  // Ensure pure ASCII so Windows cmd.exe never fails on codepage shifts
  assert.equal(/^[\x00-\x7F]*$/.test(bat), true);
});


