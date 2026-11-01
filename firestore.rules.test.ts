import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const NOW = 1761970000000;

interface AuthContext {
  uid: string;
  token: {
    email?: string;
    email_verified?: boolean;
  };
}

interface UserAccountPayload {
  uid?: unknown;
  login?: unknown;
  displayName?: unknown;
  role?: unknown;
  allowedSections?: unknown;
  active?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
}

const VALID_KEYS = [
  'uid',
  'login',
  'displayName',
  'role',
  'allowedSections',
  'active',
  'createdAt',
  'updatedAt'
];

function isValidId(id: unknown): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

function isBootstrappedAdmin(auth: AuthContext | null): boolean {
  return (
    auth !== null &&
    auth.token?.email_verified === true &&
    auth.token?.email === 'shkololoshka.invictiv@gmail.com'
  );
}

function isAdmin(auth: AuthContext | null, adminSet: Set<string>): boolean {
  if (!auth || auth.token?.email_verified !== true) return false;
  return isBootstrappedAdmin(auth) || adminSet.has(auth.uid);
}

function isValidUserAccount(data: UserAccountPayload): boolean {
  const keys = Object.keys(data);
  if (!VALID_KEYS.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => VALID_KEYS.includes(k))) return false;
  if (typeof data.uid !== 'string' || !isValidId(data.uid)) return false;
  if (typeof data.login !== 'string' || data.login.length < 2 || data.login.length > 100) return false;
  if (typeof data.displayName !== 'string' || data.displayName.length < 1 || data.displayName.length > 120) return false;
  if (typeof data.role !== 'string' || data.role.length > 20 || (data.role !== 'admin' && data.role !== 'user')) return false;
  if (!Array.isArray(data.allowedSections) || data.allowedSections.length > 25) return false;
  if (
    data.allowedSections.length > 0 &&
    (typeof data.allowedSections[0] !== 'string' ||
      data.allowedSections[0].length < 1 ||
      data.allowedSections[0].length > 50)
  ) {
    return false;
  }
  if (typeof data.active !== 'boolean') return false;
  if (typeof data.createdAt !== 'number' || typeof data.updatedAt !== 'number') return false;
  return true;
}

function evaluateUserCreate(
  auth: AuthContext | null,
  userId: string,
  incoming: UserAccountPayload,
  requestTime: number,
  adminSet: Set<string> = new Set()
): 'ALLOWED' | 'PERMISSION_DENIED' {
  const verified = auth !== null && auth.token?.email_verified === true;
  if (!verified) return 'PERMISSION_DENIED';
  if (!isValidId(userId)) return 'PERMISSION_DENIED';
  if (!isValidUserAccount(incoming)) return 'PERMISSION_DENIED';
  if (incoming.createdAt !== requestTime || incoming.updatedAt !== requestTime) return 'PERMISSION_DENIED';

  const admin = isAdmin(auth, adminSet);
  const selfRegister =
    userId === auth.uid &&
    incoming.uid === auth.uid &&
    incoming.role === 'user' &&
    incoming.active === true;

  return admin || selfRegister ? 'ALLOWED' : 'PERMISSION_DENIED';
}

function evaluateUserUpdate(
  auth: AuthContext | null,
  userId: string,
  existing: UserAccountPayload,
  incoming: UserAccountPayload,
  requestTime: number,
  adminSet: Set<string> = new Set()
): 'ALLOWED' | 'PERMISSION_DENIED' {
  const verified = auth !== null && auth.token?.email_verified === true;
  if (!verified) return 'PERMISSION_DENIED';
  if (!isValidId(userId)) return 'PERMISSION_DENIED';
  if (!isValidUserAccount(incoming)) return 'PERMISSION_DENIED';
  if (incoming.createdAt !== existing.createdAt) return 'PERMISSION_DENIED';
  if (incoming.updatedAt !== requestTime) return 'PERMISSION_DENIED';

  if (isAdmin(auth, adminSet)) return 'ALLOWED';

  const affectedKeys = Object.keys(incoming).filter(
    (k) => JSON.stringify(incoming[k]) !== JSON.stringify(existing[k])
  );
  const allowedOwnerKeys = affectedKeys.every((k) => k === 'displayName' || k === 'updatedAt');

  const ownerValid =
    userId === auth.uid &&
    existing.uid === auth.uid &&
    incoming.uid === existing.uid &&
    incoming.role === existing.role &&
    JSON.stringify(incoming.allowedSections) === JSON.stringify(existing.allowedSections) &&
    incoming.active === existing.active &&
    allowedOwnerKeys;

  return ownerValid ? 'ALLOWED' : 'PERMISSION_DENIED';
}

function evaluateUserGet(
  auth: AuthContext | null,
  userId: string,
  existing: UserAccountPayload,
  adminSet: Set<string> = new Set()
): 'ALLOWED' | 'PERMISSION_DENIED' {
  if (!auth) return 'PERMISSION_DENIED';
  if (!isValidId(userId)) return 'PERMISSION_DENIED';
  if (userId === auth.uid || existing.uid === auth.uid || isAdmin(auth, adminSet)) {
    return 'ALLOWED';
  }
  return 'PERMISSION_DENIED';
}

function makeBaseDoc(overrides: Partial<UserAccountPayload> = {}): UserAccountPayload {
  return {
    uid: 'user_1',
    login: 'operator1',
    displayName: 'Иванов И.И.',
    role: 'user',
    allowedSections: ['dublikat', 'perepak'],
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

const ADMIN_AUTH: AuthContext = {
  uid: 'admin_1',
  token: { email: 'shkololoshka.invictiv@gmail.com', email_verified: true }
};

const USER_AUTH: AuthContext = {
  uid: 'user_1',
  token: { email: 'operator1@example.com', email_verified: true }
};

test('Dirty Dozen #1: Unauthenticated write is PERMISSION_DENIED', () => {
  assert.equal(evaluateUserCreate(null, 'user_1', makeBaseDoc(), NOW), 'PERMISSION_DENIED');
});

test('Dirty Dozen #2: Unverified email spoof of bootstrapped admin is PERMISSION_DENIED', () => {
  const spoofAuth: AuthContext = {
    uid: 'spoof_1',
    token: { email: 'shkololoshka.invictiv@gmail.com', email_verified: false }
  };
  assert.equal(evaluateUserCreate(spoofAuth, 'user_1', makeBaseDoc(), NOW), 'PERMISSION_DENIED');
});

test('Dirty Dozen #3: Self-assigned admin role by non-admin is PERMISSION_DENIED', () => {
  assert.equal(
    evaluateUserCreate(USER_AUTH, 'user_1', makeBaseDoc({ role: 'admin' }), NOW),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #4: Shadow field injection on create is PERMISSION_DENIED', () => {
  assert.equal(
    evaluateUserCreate(ADMIN_AUTH, 'user_1', makeBaseDoc({ isSuperUser: true }), NOW),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #5: Shadow field injection on update is PERMISSION_DENIED', () => {
  const existing = makeBaseDoc();
  const updated = makeBaseDoc({ displayName: 'Петров П.П.', hacked: true, updatedAt: NOW + 1000 });
  assert.equal(
    evaluateUserUpdate(USER_AUTH, 'user_1', existing, updated, NOW + 1000),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #6: Privilege escalation on update by owner is PERMISSION_DENIED', () => {
  const existing = makeBaseDoc();
  const updated = makeBaseDoc({ role: 'admin', updatedAt: NOW + 1000 });
  assert.equal(
    evaluateUserUpdate(USER_AUTH, 'user_1', existing, updated, NOW + 1000),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #7: ID poisoning attack is PERMISSION_DENIED', () => {
  assert.equal(
    evaluateUserCreate(ADMIN_AUTH, 'bad$user!id', makeBaseDoc(), NOW),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #8: Value poisoning (oversized displayName > 120 chars) is PERMISSION_DENIED', () => {
  assert.equal(
    evaluateUserCreate(ADMIN_AUTH, 'user_1', makeBaseDoc({ displayName: 'A'.repeat(150) }), NOW),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #9: Array overflow (> 25 allowedSections) is PERMISSION_DENIED', () => {
  const tooMany = Array.from({ length: 26 }, (_, i) => `sec_${i}`);
  assert.equal(
    evaluateUserCreate(ADMIN_AUTH, 'user_1', makeBaseDoc({ allowedSections: tooMany }), NOW),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #10: Array element type poisoning (non-string first element) is PERMISSION_DENIED', () => {
  assert.equal(
    evaluateUserCreate(ADMIN_AUTH, 'user_1', makeBaseDoc({ allowedSections: [12345] }), NOW),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #11: Timestamp forgery or createdAt mutation is PERMISSION_DENIED', () => {
  assert.equal(
    evaluateUserCreate(ADMIN_AUTH, 'user_1', makeBaseDoc({ createdAt: NOW - 5000 }), NOW),
    'PERMISSION_DENIED'
  );
  const existing = makeBaseDoc();
  const mutatedCreated = makeBaseDoc({ createdAt: NOW + 500, updatedAt: NOW + 1000 });
  assert.equal(
    evaluateUserUpdate(ADMIN_AUTH, 'user_1', existing, mutatedCreated, NOW + 1000),
    'PERMISSION_DENIED'
  );
});

test('Dirty Dozen #12: Horizontal PII scraping by another non-admin user is PERMISSION_DENIED', () => {
  const otherUser: AuthContext = {
    uid: 'user_2',
    token: { email: 'user2@example.com', email_verified: true }
  };
  assert.equal(evaluateUserGet(otherUser, 'user_1', makeBaseDoc()), 'PERMISSION_DENIED');
});

test('Positive check: Verified admin can create and update user accounts, and rules file contains required guards', () => {
  assert.equal(evaluateUserCreate(ADMIN_AUTH, 'user_1', makeBaseDoc(), NOW), 'ALLOWED');
  const existing = makeBaseDoc();
  const updated = makeBaseDoc({
    allowedSections: ['dublikat', 'perepak', 'gtin', 'sverka'],
    updatedAt: NOW + 1000
  });
  assert.equal(
    evaluateUserUpdate(ADMIN_AUTH, 'user_1', existing, updated, NOW + 1000),
    'ALLOWED'
  );

  const rulesPath = fs.existsSync(path.resolve('firestore.rules'))
    ? path.resolve('firestore.rules')
    : path.resolve('DRAFT_firestore.rules');
  const rulesText = fs.readFileSync(rulesPath, 'utf-8');
  assert.ok(rulesText.includes("rules_version = '2';"));
  assert.ok(rulesText.includes('allow read, write: if false;'));
  assert.ok(rulesText.includes('isValidUserAccount(incoming())'));
  assert.ok(rulesText.includes('shkololoshka.invictiv@gmail.com'));
});
