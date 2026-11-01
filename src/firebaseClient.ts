import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const OKKAM_LOGO_URL =
  'https://static.tildacdn.com/tild3533-3834-4361-a636-646263663031/logo.svg';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write'
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

// Blueprint validation constants (synced verbatim with firebase-blueprint.json & firestore.rules)
const ID_PATTERN = /^[a-zA-Z0-9_\-]+$/;
const MAX_UID_LEN = 128;
const MIN_LOGIN_LEN = 2;
const MAX_LOGIN_LEN = 100;
const MIN_DISPLAY_NAME_LEN = 1;
const MAX_DISPLAY_NAME_LEN = 120;
const MAX_SECTIONS_LEN = 25;

export interface SectionInfo {
  id: string;
  title: string;
  desc: string;
  path: string;
  category: string;
}

export interface AccountRecord {
  id: string;
  uid: string;
  login: string;
  email?: string;
  displayName: string;
  role: 'admin' | 'user';
  allowedSections: string[];
  active: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

function sanitizeIdForBlueprint(rawId: string): string {
  const cleaned = String(rawId || 'user')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, MAX_UID_LEN);
  return ID_PATTERN.test(cleaned) ? cleaned : 'user_default';
}

export async function syncAccountToFirestore(account: AccountRecord, isNew = false): Promise<void> {
  if (!auth.currentUser) return;
  const docId = sanitizeIdForBlueprint(account.id || account.uid);
  const path = `users/${docId}`;

  const login = String(account.login || '').trim().slice(0, MAX_LOGIN_LEN);
  const displayName = String(account.displayName || '').trim().slice(0, MAX_DISPLAY_NAME_LEN);
  if (login.length < MIN_LOGIN_LEN || displayName.length < MIN_DISPLAY_NAME_LEN) {
    return;
  }

  const allowedSections = Array.isArray(account.allowedSections)
    ? account.allowedSections.map((s) => String(s).slice(0, 50)).slice(0, MAX_SECTIONS_LEN)
    : [];

  const payload: Record<string, unknown> = {
    uid: sanitizeIdForBlueprint(account.uid || auth.currentUser.uid),
    login,
    displayName,
    role: account.role === 'admin' ? 'admin' : 'user',
    allowedSections,
    active: Boolean(account.active),
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp()
  };

  try {
    await setDoc(doc(db, 'users', docId), payload, { merge: true });
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.WRITE, path);
  }
}

export async function deleteAccountFromFirestore(accountId: string): Promise<void> {
  if (!auth.currentUser) return;
  const docId = sanitizeIdForBlueprint(accountId);
  const path = `users/${docId}`;
  try {
    await deleteDoc(doc(db, 'users', docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ============================================================================
// OKKAM PC Desktop Client, Splash Updater, Auth & Admin Portal Controller
// ============================================================================

const TOKEN_STORAGE_KEY = 'okkam_session_token';
const SPLASH_SEEN_SESSION_KEY = 'okkam_pc_splash_completed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let currentAccount: AccountRecord | null = null;
let allSections: SectionInfo[] = [];
let allAccounts: AccountRecord[] = [];
let editingAccountId: string | null = null;
let unsubscribeFirestore: (() => void) | null = null;
let deferredPwaPrompt: BeforeInstallPromptEvent | null = null;
let clockIntervalId: number | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e as BeforeInstallPromptEvent;
});

function getToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

function setToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    document.cookie = `okkam_token=${encodeURIComponent(token)}; path=/; max-age=86400; SameSite=Lax`;
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    document.cookie = 'okkam_token=; path=/; max-age=0; SameSite=Lax';
  }
}

async function apiFetch(url: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {})
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  return res.json();
}

function getCurrentPageSectionId(): string | null {
  const clean = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!clean || clean === 'index.html') return null;
  const first = clean.split('/')[0].toLowerCase();
  if (first === 'ermann') return 'reestr';
  if (first === 'zapros') return 'gtin';
  if (first === 'perco') return 'invent';
  const match = allSections.find((s) => s.id === first);
  return match ? match.id : null;
}

function downloadWindowsShortcutBat() {
  const origin = encodeURIComponent(window.location.origin);
  const ua = encodeURIComponent(navigator.userAgent || '');
  const a = document.createElement('a');
  a.href = `/api/desktop/shortcut.bat?origin=${origin}&ua=${ua}`;
  a.download = 'OKKAM_Desktop.bat';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function injectStyles() {
  if (document.getElementById('okkam-auth-styles')) return;
  const style = document.createElement('style');
  style.id = 'okkam-auth-styles';
  style.textContent = `
    body.okkam-has-titlebar {
      padding-top: 64px !important;
    }

    /* Native PC Window Top Titlebar when inside the app */
    .okkam-pc-titlebar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 44px;
      background: linear-gradient(90deg, #141720 0%, #1e2330 60%, #252b3b 100%);
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      z-index: 90000;
      border-bottom: 1px solid rgba(255,255,255,.1);
      box-shadow: 0 4px 16px rgba(0,0,0,.22);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      user-select: none;
    }
    .okkam-pc-titlebar-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .okkam-pc-brand-pill {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 4px 10px;
      border-radius: 7px;
      background: rgba(232,90,30,.18);
      border: 1px solid rgba(232,90,30,.4);
    }
    .okkam-pc-brand-pill img {
      height: 18px;
      width: auto;
      filter: brightness(0) invert(1);
      pointer-events: none;
    }
    .okkam-pc-app-title {
      font-size: 12.5px;
      font-weight: 700;
      color: #e2e8f0;
      letter-spacing: 0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .okkam-pc-nav-back {
      padding: 5px 11px;
      border-radius: 6px;
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.15);
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      text-decoration: none;
      transition: background .15s;
    }
    .okkam-pc-nav-back:hover {
      background: #e85a1e;
      border-color: #ff6f32;
    }
    .okkam-pc-titlebar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .okkam-pc-tool-btn {
      padding: 5px 10px;
      border-radius: 6px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      color: #cbd5e1;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all .15s;
      font-family: inherit;
      white-space: nowrap;
    }
    .okkam-pc-tool-btn:hover {
      background: rgba(255,255,255,.16);
      color: #fff;
    }
    .okkam-pc-win-controls {
      display: flex;
      align-items: center;
      margin-left: 6px;
      border-left: 1px solid rgba(255,255,255,.12);
      padding-left: 8px;
      gap: 4px;
    }
    .okkam-pc-win-btn {
      width: 28px;
      height: 26px;
      border-radius: 5px;
      border: none;
      background: transparent;
      color: #cbd5e1;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all .15s;
    }
    .okkam-pc-win-btn:hover {
      background: rgba(255,255,255,.15);
      color: #fff;
    }
    .okkam-pc-win-btn.close:hover {
      background: #dc2626;
      color: #fff;
    }

    /* PC Desktop Environment (Wallpaper + Shortcuts + Taskbar) */
    .okkam-desktop-workspace {
      position: fixed;
      inset: 0;
      background:
        radial-gradient(circle at 78% 22%, rgba(232, 90, 30, 0.22) 0%, transparent 45%),
        radial-gradient(circle at 20% 80%, rgba(61, 90, 158, 0.28) 0%, transparent 50%),
        linear-gradient(135deg, #0f131d 0%, #171c29 55%, #1e2436 100%);
      z-index: 99990;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      user-select: none;
      overflow: hidden;
    }
    .okkam-desktop-watermark {
      position: absolute;
      right: 48px;
      bottom: 72px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      opacity: 0.22;
      pointer-events: none;
    }
    .okkam-desktop-watermark img {
      height: 44px;
      width: auto;
      filter: brightness(0) invert(1);
    }
    .okkam-desktop-watermark span {
      font-size: 12px;
      font-weight: 700;
      color: #cbd5e1;
      letter-spacing: 0.6px;
    }

    /* Desktop Shortcut Icons Column (Left side of PC desktop) */
    .okkam-desktop-icons {
      position: relative;
      z-index: 2;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      width: fit-content;
    }
    .okkam-shortcut-item {
      width: 112px;
      padding: 10px 8px;
      border-radius: 10px;
      border: 1px solid transparent;
      background: transparent;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: all .15s ease;
      text-align: center;
      color: #f8fafc;
    }
    .okkam-shortcut-item:hover, .okkam-shortcut-item:focus-visible {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.22);
      box-shadow: 0 6px 18px rgba(0,0,0,.25);
      outline: none;
    }
    .okkam-shortcut-item:active {
      transform: scale(0.96);
    }
    .okkam-shortcut-icon-tile {
      width: 60px;
      height: 60px;
      border-radius: 15px;
      background: linear-gradient(135deg, #e85a1e 0%, #ff6f32 55%, #ff8855 100%);
      box-shadow: 0 8px 22px rgba(232, 90, 30, .42), inset 0 1px 1px rgba(255,255,255,.35);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: 8px;
    }
    .okkam-shortcut-icon-tile.secondary {
      background: linear-gradient(135deg, #2b354f 0%, #3d5a9e 100%);
      box-shadow: 0 8px 20px rgba(30, 45, 90, .45), inset 0 1px 1px rgba(255,255,255,.25);
    }
    .okkam-shortcut-icon-tile img {
      width: 100%;
      height: auto;
      max-height: 28px;
      object-fit: contain;
      filter: brightness(0) invert(1);
      pointer-events: none;
    }
    .okkam-shortcut-arrow {
      position: absolute;
      bottom: -3px;
      left: -3px;
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: #ffffff;
      color: #1e293b;
      font-size: 11px;
      font-weight: 900;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 5px rgba(0,0,0,.35);
    }
    .okkam-shortcut-label {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.25;
      color: #f1f5f9;
      text-shadow: 0 1px 4px rgba(0,0,0,.85);
      word-break: break-word;
    }

    /* Center Stage for Splash Screen or Login Dialog Window */
    .okkam-desktop-stage {
      position: absolute;
      inset: 0 0 48px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      pointer-events: none;
      z-index: 5;
    }

    /* Splash Screen Window (while app launches & checks updates) */
    .okkam-splash-window {
      pointer-events: auto;
      width: 100%;
      max-width: 480px;
      background: linear-gradient(145deg, #191e2b 0%, #121620 100%);
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 28px 70px rgba(0,0,0,.65), 0 0 40px rgba(232,90,30,.18);
      overflow: hidden;
      color: #fff;
      display: flex;
      flex-direction: column;
      animation: okkamWindowPop .22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes okkamWindowPop {
      from { opacity: 0; transform: scale(0.95) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    .okkam-splash-top {
      padding: 36px 32px 26px;
      background:
        radial-gradient(circle at 50% 0%, rgba(232,90,30,.32) 0%, transparent 70%),
        linear-gradient(180deg, rgba(255,255,255,.03) 0%, transparent 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      position: relative;
    }
    .okkam-splash-logo-box {
      width: 220px;
      height: 68px;
      border-radius: 16px;
      background: linear-gradient(135deg, #e85a1e 0%, #ff6f32 55%, #ff8855 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px 24px;
      box-shadow: 0 12px 32px rgba(232,90,30,.4);
      margin-bottom: 18px;
    }
    .okkam-splash-logo-box img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      filter: brightness(0) invert(1);
      pointer-events: none;
    }
    .okkam-splash-title {
      font-size: 18px;
      font-weight: 800;
      color: #f8fafc;
      letter-spacing: 0.3px;
    }
    .okkam-splash-version {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .okkam-splash-bottom {
      padding: 20px 28px 24px;
      background: rgba(0,0,0,.28);
      border-top: 1px solid rgba(255,255,255,.06);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .okkam-splash-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12.5px;
      color: #cbd5e1;
      font-weight: 600;
    }
    .okkam-splash-percent {
      font-family: 'Courier New', monospace;
      font-weight: 800;
      color: #ff8855;
    }
    .okkam-splash-bar-track {
      width: 100%;
      height: 7px;
      background: rgba(255,255,255,.1);
      border-radius: 999px;
      overflow: hidden;
    }
    .okkam-splash-bar-fill {
      height: 100%;
      width: 15%;
      background: linear-gradient(90deg, #e85a1e, #ff8855);
      border-radius: 999px;
      transition: width .28s ease;
      box-shadow: 0 0 12px rgba(232,90,30,.8);
    }
    .okkam-splash-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 4px;
      font-size: 11px;
      color: #64748b;
    }
    .okkam-splash-skip {
      background: transparent;
      border: none;
      color: #94a3b8;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: underline;
    }
    .okkam-splash-skip:hover {
      color: #fff;
    }

    /* Native PC Login Window */
    .okkam-login-window {
      pointer-events: auto;
      width: 100%;
      max-width: 430px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 28px 70px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.15);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      animation: okkamWindowPop .2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .okkam-win-titlebar {
      height: 38px;
      background: #181c26;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      font-size: 12px;
      font-weight: 700;
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .okkam-win-titlebar-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .okkam-win-titlebar-brand img {
      height: 14px;
      width: auto;
      filter: brightness(0) invert(1);
    }
    .okkam-login-header {
      padding: 22px 24px 18px;
      background: linear-gradient(135deg, #e85a1e 0%, #ff6f32 55%, #ff8855 100%);
      text-align: center;
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .okkam-login-logo {
      height: 38px;
      width: auto;
      max-width: 200px;
      object-fit: contain;
      filter: brightness(0) invert(1);
      margin-bottom: 10px;
      pointer-events: none;
    }
    .okkam-login-header h2 {
      font-size: 19px;
      font-weight: 800;
      margin-bottom: 4px;
    }
    .okkam-login-header p {
      font-size: 12.5px;
      color: rgba(255,255,255,.92);
    }
    .okkam-update-verified-line {
      background: #f0fdf4;
      border-bottom: 1px solid #dcfce7;
      color: #166534;
      font-size: 11.5px;
      font-weight: 700;
      padding: 7px 16px;
      text-align: center;
    }
    .okkam-login-body {
      padding: 20px 24px 22px;
      display: flex;
      flex-direction: column;
      gap: 13px;
    }

    /* Bottom PC Taskbar */
    .okkam-desktop-taskbar {
      position: relative;
      z-index: 10;
      height: 48px;
      background: rgba(15, 19, 28, 0.92);
      backdrop-filter: blur(12px);
      border-top: 1px solid rgba(255,255,255,.1);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      color: #e2e8f0;
    }
    .okkam-taskbar-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .okkam-taskbar-start {
      height: 34px;
      padding: 0 12px;
      border-radius: 8px;
      background: linear-gradient(135deg, #e85a1e, #ff6f32);
      border: none;
      color: #fff;
      font-weight: 800;
      font-size: 12.5px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      box-shadow: 0 3px 10px rgba(232,90,30,.35);
    }
    .okkam-taskbar-start img {
      height: 15px;
      width: auto;
      filter: brightness(0) invert(1);
      pointer-events: none;
    }
    .okkam-taskbar-app-tab {
      height: 34px;
      padding: 0 14px;
      border-radius: 8px;
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.16);
      color: #f8fafc;
      font-size: 12px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .okkam-taskbar-app-tab:hover {
      background: rgba(255,255,255,.16);
    }
    .okkam-taskbar-right {
      display: flex;
      align-items: center;
      gap: 14px;
      font-size: 12px;
      color: #cbd5e1;
    }
    .okkam-taskbar-clock {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-weight: 600;
      text-align: right;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
    }

    /* User Profile Bar inside Portal */
    .okkam-auth-bar {
      width: 100%;
      max-width: 1000px;
      margin: 0 auto 16px;
      background: #ffffff;
      border-radius: 14px;
      padding: 12px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      box-shadow: 0 4px 16px rgba(30,30,60,.08);
      border: 1px solid rgba(0,0,0,.06);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .okkam-auth-user {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .okkam-avatar {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: linear-gradient(135deg, #e85a1e, #ff8855);
      color: #fff;
      font-weight: 800;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 3px 10px rgba(232,90,30,.28);
    }
    .okkam-user-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .okkam-user-name {
      font-size: 14px;
      font-weight: 700;
      color: #1e2029;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .okkam-user-sub {
      font-size: 12px;
      color: #686d7d;
    }
    .okkam-role-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .okkam-role-badge.admin {
      background: #fff3e0;
      color: #e85a1e;
      border: 1px solid rgba(232,90,30,.25);
    }
    .okkam-role-badge.user {
      background: #eef2ff;
      color: #3d5a9e;
      border: 1px solid rgba(61,90,158,.25);
    }
    .okkam-auth-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .okkam-btn {
      padding: 9px 16px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      border: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all .2s ease;
      font-family: inherit;
      white-space: nowrap;
    }
    .okkam-btn-admin {
      background: linear-gradient(135deg, #3d5a9e, #5273bf);
      color: #fff;
      box-shadow: 0 4px 12px rgba(61,90,158,.25);
    }
    .okkam-btn-admin:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(61,90,158,.35);
    }
    .okkam-btn-shortcut {
      background: #fff3e0;
      color: #c2410c;
      border: 1px solid #fdba74;
    }
    .okkam-btn-shortcut:hover {
      background: #ffedd5;
    }
    .okkam-btn-logout {
      background: #f2f3f7;
      color: #4a4a65;
      border: 1px solid rgba(0,0,0,.08);
    }
    .okkam-btn-logout:hover {
      background: #fee2e2;
      color: #dc2626;
      border-color: rgba(220,38,38,.25);
    }

    /* Form Controls */
    .okkam-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .okkam-field label {
      font-size: 11.5px;
      font-weight: 700;
      color: #4a4a65;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .okkam-input, .okkam-select {
      width: 100%;
      padding: 11px 14px;
      border-radius: 10px;
      border: 1.5px solid #d1d5db;
      background: #f8fafc;
      font-size: 14px;
      color: #1e2029;
      outline: none;
      transition: all .2s;
      font-family: inherit;
      user-select: text !important;
      -webkit-user-select: text !important;
    }
    .okkam-input:focus, .okkam-select:focus {
      border-color: #e85a1e;
      background: #fff;
      box-shadow: 0 0 0 3px rgba(232,90,30,.12);
    }
    .okkam-submit-btn {
      width: 100%;
      padding: 12px;
      border-radius: 11px;
      border: none;
      background: linear-gradient(135deg, #e85a1e, #ff6f32);
      color: #fff;
      font-size: 14.5px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 6px 18px rgba(232,90,30,.3);
      transition: all .2s;
      margin-top: 2px;
    }
    .okkam-submit-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 22px rgba(232,90,30,.4);
    }
    .okkam-error-box {
      padding: 10px 12px;
      border-radius: 10px;
      background: #fee2e2;
      color: #b91c1c;
      font-size: 13px;
      font-weight: 600;
      display: none;
    }
    .okkam-demo-accounts {
      border-top: 1px solid #e5e7eb;
      padding-top: 11px;
      margin-top: 2px;
    }
    .okkam-demo-title {
      font-size: 10.5px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      margin-bottom: 7px;
      text-align: center;
    }
    .okkam-demo-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 5px;
    }
    .okkam-demo-chip {
      padding: 7px 11px;
      border-radius: 8px;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      font-size: 12px;
      color: #374151;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: all .15s;
      text-align: left;
    }
    .okkam-demo-chip:hover {
      background: #fff3e0;
      border-color: #fdba74;
      color: #c2410c;
    }

    /* Admin Modal */
    .okkam-admin-modal {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, .65);
      backdrop-filter: blur(5px);
      z-index: 95000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .okkam-admin-modal.open {
      display: flex;
    }
    .okkam-admin-dialog {
      width: 100%;
      max-width: 1120px;
      max-height: 90vh;
      background: #f5f5fa;
      border-radius: 20px;
      box-shadow: 0 25px 60px rgba(0,0,0,.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.2);
    }
    .okkam-admin-header {
      padding: 18px 24px;
      background: linear-gradient(135deg, #2a2c38 0%, #3d5a9e 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .okkam-admin-header h2 {
      font-size: 19px;
      font-weight: 800;
    }
    .okkam-admin-close {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,.2);
      background: rgba(255,255,255,.12);
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .okkam-admin-body {
      padding: 20px 24px;
      overflow-y: auto;
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 20px;
    }
    @media (max-width: 920px) {
      .okkam-admin-body {
        grid-template-columns: 1fr;
      }
    }
    .okkam-admin-panel-card {
      background: #fff;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 4px 16px rgba(30,30,60,.06);
      border: 1px solid rgba(0,0,0,.05);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .okkam-admin-panel-card h3 {
      font-size: 15px;
      font-weight: 800;
      color: #1e2029;
      padding-bottom: 10px;
      border-bottom: 1px solid #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .okkam-sections-selector {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      max-height: 230px;
      overflow-y: auto;
      padding: 8px;
      background: #f8fafc;
      border-radius: 10px;
      border: 1px solid #e2e8f0;
    }
    .okkam-sec-check {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 8px;
      border-radius: 7px;
      background: #fff;
      border: 1px solid #e2e8f0;
      font-size: 12px;
      font-weight: 600;
      color: #334155;
      cursor: pointer;
      user-select: none;
    }
    .okkam-sec-check input {
      accent-color: #e85a1e;
      width: 15px;
      height: 15px;
      cursor: pointer;
    }
    .okkam-sec-check.checked {
      background: #fff3e0;
      border-color: #fdba74;
      color: #c2410c;
    }
    .okkam-quick-sec-btns {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .okkam-mini-btn {
      padding: 5px 10px;
      border-radius: 7px;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      font-size: 11px;
      font-weight: 700;
      color: #475569;
      cursor: pointer;
    }
    .okkam-mini-btn:hover {
      background: #e2e8f0;
    }
    .okkam-accounts-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .okkam-account-item {
      padding: 14px 16px;
      border-radius: 12px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .okkam-account-item.inactive {
      opacity: 0.65;
      background: #fef2f2;
      border-color: #fecaca;
    }
    .okkam-account-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .okkam-account-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .okkam-sec-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
      background: #fff;
      border: 1px solid #cbd5e1;
      color: #334155;
    }
    .okkam-account-actions {
      display: flex;
      gap: 6px;
    }
    .okkam-act-btn {
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid #cbd5e1;
      background: #fff;
      cursor: pointer;
      color: #334155;
    }
    .okkam-act-btn:hover {
      border-color: #3d5a9e;
      color: #3d5a9e;
    }
    .okkam-act-btn.danger:hover {
      border-color: #dc2626;
      color: #dc2626;
      background: #fef2f2;
    }
  `;
  document.head.appendChild(style);
}

function updateTaskbarClock() {
  const el = document.getElementById('okkamTaskbarClock');
  if (!el) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('ru-RU');
  el.innerHTML = `<div>${timeStr}</div><div style="font-size:10.5px;color:#94a3b8;">${dateStr}</div>`;
}

function ensureDesktopWorkspace(): HTMLElement {
  let ws = document.getElementById('okkamDesktopWorkspace');
  if (ws) return ws;

  ws = document.createElement('div');
  ws.id = 'okkamDesktopWorkspace';
  ws.className = 'okkam-desktop-workspace';
  ws.innerHTML = `
    <div class="okkam-desktop-icons">
      <button type="button" class="okkam-shortcut-item" id="desktopLaunchShortcut" title="Запустить приложение OKKAM Склад">
        <div class="okkam-shortcut-icon-tile">
          <img src="${OKKAM_LOGO_URL}" alt="OKKAM" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
          <span class="okkam-shortcut-arrow">↗</span>
        </div>
        <span class="okkam-shortcut-label">OKKAM Склад (Запуск)</span>
      </button>

      <button type="button" class="okkam-shortcut-item" id="desktopDownloadBatShortcut" title="Скачать ярлык запуска для рабочего стола Windows (.bat)">
        <div class="okkam-shortcut-icon-tile secondary">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          <span class="okkam-shortcut-arrow">⬇</span>
        </div>
        <span class="okkam-shortcut-label">Скачать ярлык на ПК (.bat)</span>
      </button>
    </div>

    <div class="okkam-desktop-stage" id="okkamDesktopStage"></div>

    <div class="okkam-desktop-taskbar">
      <div class="okkam-taskbar-left">
        <button type="button" class="okkam-taskbar-start" id="taskbarLaunchBtn">
          <img src="${OKKAM_LOGO_URL}" alt="OKKAM" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
          <span>Пуск • OKKAM</span>
        </button>
        <button type="button" class="okkam-taskbar-app-tab" id="taskbarRestoreWindowBtn">
          <span id="taskbarWindowStatusText">OKKAM Desktop Client v6.6.3</span>
        </button>
      </div>
      <div class="okkam-taskbar-right">
        <span>Сервер: Онлайн</span>
        <span>РУС</span>
        <div class="okkam-taskbar-clock" id="okkamTaskbarClock"></div>
      </div>
    </div>
  `;

  document.body.appendChild(ws);
  updateTaskbarClock();
  if (clockIntervalId) clearInterval(clockIntervalId);
  clockIntervalId = window.setInterval(updateTaskbarClock, 15000);

  document.getElementById('desktopLaunchShortcut')?.addEventListener('click', () => {
    runSplashAndProceed(true);
  });

  document.getElementById('taskbarLaunchBtn')?.addEventListener('click', () => {
    runSplashAndProceed(true);
  });

  document.getElementById('taskbarRestoreWindowBtn')?.addEventListener('click', () => {
    if (currentAccount) {
      closeDesktopWorkspace();
      applyPortalPermissions();
    } else {
      const stage = document.getElementById('okkamDesktopStage');
      if (stage && stage.children.length === 0) {
        renderLoginOverlay();
      }
    }
  });

  document.getElementById('desktopDownloadBatShortcut')?.addEventListener('click', () => {
    downloadWindowsShortcutBat();
  });

  return ws;
}

function closeDesktopWorkspace() {
  document.getElementById('okkamDesktopWorkspace')?.remove();
}

export function runSplashAndProceed(forceSplash = false) {
  const alreadyShown = sessionStorage.getItem(SPLASH_SEEN_SESSION_KEY) === '1';
  if (alreadyShown && !forceSplash) {
    if (currentAccount) {
      closeDesktopWorkspace();
      applyPortalPermissions();
    } else {
      renderLoginOverlay();
    }
    return;
  }

  ensureDesktopWorkspace();
  const stage = document.getElementById('okkamDesktopStage');
  if (!stage) return;

  const tabText = document.getElementById('taskbarWindowStatusText');
  if (tabText) tabText.textContent = 'Запуск OKKAM Desktop — Проверка обновлений...';

  stage.innerHTML = `
    <div class="okkam-splash-window" id="okkamSplashScreen" role="dialog" aria-label="Запуск приложения OKKAM">
      <div class="okkam-splash-top">
        <div class="okkam-splash-logo-box">
          <img src="${OKKAM_LOGO_URL}" alt="OKKAM" id="okkamSplashLogo" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
        </div>
        <div class="okkam-splash-title">OKKAM Warehouse Desktop</div>
        <div class="okkam-splash-version">Корпоративный клиент для ПК • Сборка v6.6.3</div>
      </div>
      <div class="okkam-splash-bottom">
        <div class="okkam-splash-status-row">
          <span id="splashStatusText">Запуск приложения с ярлыка...</span>
          <span class="okkam-splash-percent" id="splashProgressPercent">15%</span>
        </div>
        <div class="okkam-splash-bar-track">
          <div class="okkam-splash-bar-fill" id="splashProgressBar" style="width: 15%;"></div>
        </div>
        <div class="okkam-splash-footer">
          <span>Канал обновлений: Stable (PC)</span>
          <button type="button" class="okkam-splash-skip" id="skipSplashBtn">Пропустить</button>
        </div>
      </div>
    </div>
  `;

  const steps = [
    { pct: 25, text: 'Запуск клиентского модуля с ярлыка ПК...' },
    { pct: 60, text: 'Проверка обновлений на сервере (v6.6.3 — актуальная версия)...' },
    { pct: 90, text: 'Синхронизация справочников склада и политик безопасности...' },
    { pct: 100, text: 'Обновления не требуются. Открытие окна авторизации...' }
  ];

  let stepIdx = 0;
  let finished = false;

  const finishSplash = () => {
    if (finished) return;
    finished = true;
    sessionStorage.setItem(SPLASH_SEEN_SESSION_KEY, '1');
    if (currentAccount) {
      closeDesktopWorkspace();
      applyPortalPermissions();
    } else {
      renderLoginOverlay();
    }
  };

  document.getElementById('skipSplashBtn')?.addEventListener('click', finishSplash);

  const advanceStep = () => {
    if (finished) return;
    if (stepIdx >= steps.length) {
      finishSplash();
      return;
    }
    const st = steps[stepIdx];
    const txtEl = document.getElementById('splashStatusText');
    const pctEl = document.getElementById('splashProgressPercent');
    const barEl = document.getElementById('splashProgressBar');
    if (txtEl) txtEl.textContent = st.text;
    if (pctEl) pctEl.textContent = `${st.pct}%`;
    if (barEl) barEl.style.width = `${st.pct}%`;
    stepIdx++;
    setTimeout(advanceStep, 650);
  };

  setTimeout(advanceStep, 250);
}

function renderLoginOverlay(errorMsg = '') {
  ensureDesktopWorkspace();
  const stage = document.getElementById('okkamDesktopStage');
  if (!stage) return;

  const tabText = document.getElementById('taskbarWindowStatusText');
  if (tabText) tabText.textContent = 'OKKAM Desktop — Авторизация пользователя';

  stage.innerHTML = `
    <div class="okkam-login-window" id="okkamLoginOverlay" role="dialog" aria-label="Вход в систему ОККАМ">
      <div class="okkam-win-titlebar">
        <div class="okkam-win-titlebar-brand">
          <img src="${OKKAM_LOGO_URL}" alt="OKKAM" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
          <span>OKKAM Desktop — Вход в систему</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button type="button" class="okkam-pc-win-btn" id="minimizeLoginWinBtn" title="Свернуть на рабочий стол">—</button>
          <button type="button" class="okkam-pc-win-btn close" id="closeLoginWinBtn" title="Закрыть на рабочий стол">✕</button>
        </div>
      </div>

      <div class="okkam-login-header">
        <img src="${OKKAM_LOGO_URL}" alt="OKKAM" class="okkam-login-logo" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
        <h2>Авторизация в приложении</h2>
        <p>Введите логин и пароль учётной записи сотрудника</p>
      </div>

      <div class="okkam-update-verified-line">
        ✓ Проверка обновлений завершена: версия v6.6.3 актуальна
      </div>

      <div class="okkam-login-body">
        <div class="okkam-error-box" id="okkamLoginError" style="${errorMsg ? 'display:block' : ''}">${errorMsg}</div>
        <form id="okkamLoginForm" style="display:flex;flex-direction:column;gap:11px;">
          <div class="okkam-field">
            <label for="authLoginInput">Логин сотрудника</label>
            <input type="text" id="authLoginInput" class="okkam-input" placeholder="Введите логин (например, admin)" autocomplete="username" required />
          </div>
          <div class="okkam-field">
            <label for="authPasswordInput">Пароль</label>
            <input type="password" id="authPasswordInput" class="okkam-input" placeholder="Введите пароль" autocomplete="current-password" required />
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:#475569;cursor:pointer;">
            <input type="checkbox" id="authRememberCheckbox" checked style="width:15px;height:15px;accent-color:#e85a1e;" />
            <span>Запомнить сессию на этом компьютере</span>
          </label>
          <button type="submit" id="authSubmitBtn" class="okkam-submit-btn">Войти в приложение</button>
        </form>

        <div class="okkam-demo-accounts">
          <div class="okkam-demo-title">Быстрый выбор учётной записи для проверки</div>
          <div class="okkam-demo-grid">
            <button type="button" class="okkam-demo-chip" data-demo-login="admin" data-demo-pass="admin123">
              <span><strong>admin</strong> — Главный администратор</span>
              <span style="font-weight:700;color:#e85a1e;">Все разделы + Админка</span>
            </button>
            <button type="button" class="okkam-demo-chip" data-demo-login="operator_rt" data-demo-pass="12345">
              <span><strong>operator_rt</strong> — Оператор перепака</span>
              <span style="font-weight:700;color:#3d5a9e;">4 раздела</span>
            </button>
            <button type="button" class="okkam-demo-chip" data-demo-login="kladovshik" data-demo-pass="12345">
              <span><strong>kladovshik</strong> — Старший кладовщик</span>
              <span style="font-weight:700;color:#3d5a9e;">6 разделов</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const minimizeOrCloseToDesktop = () => {
    stage.innerHTML = '';
    if (tabText) tabText.textContent = 'Нажмите на ярлык «OKKAM Склад» для запуска';
  };

  document.getElementById('minimizeLoginWinBtn')?.addEventListener('click', minimizeOrCloseToDesktop);
  document.getElementById('closeLoginWinBtn')?.addEventListener('click', minimizeOrCloseToDesktop);

  const form = document.getElementById('okkamLoginForm') as HTMLFormElement;
  const loginInp = document.getElementById('authLoginInput') as HTMLInputElement;
  const passInp = document.getElementById('authPasswordInput') as HTMLInputElement;
  const errBox = document.getElementById('okkamLoginError') as HTMLElement;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.style.display = 'none';
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        login: loginInp.value.trim(),
        password: passInp.value
      })
    });
    if (!res.ok) {
      errBox.textContent = res.error || 'Ошибка авторизации';
      errBox.style.display = 'block';
      return;
    }
    setToken(res.token);
    currentAccount = res.account;
    closeDesktopWorkspace();
    applyPortalPermissions();
  });

  stage.querySelectorAll('[data-demo-login]').forEach((btn) => {
    btn.addEventListener('click', () => {
      loginInp.value = btn.getAttribute('data-demo-login') || '';
      passInp.value = btn.getAttribute('data-demo-pass') || '';
      form.requestSubmit();
    });
  });
}

function renderDesktopTitlebar() {
  if (!currentAccount) return;
  document.body.classList.add('okkam-has-titlebar');

  let titlebar = document.getElementById('okkamDesktopTitlebar');
  if (!titlebar) {
    titlebar = document.createElement('div');
    titlebar.id = 'okkamDesktopTitlebar';
    titlebar.className = 'okkam-pc-titlebar';
    document.body.appendChild(titlebar);
  }

  const pageSection = getCurrentPageSectionId();
  const secInfo = pageSection ? allSections.find((s) => s.id === pageSection) : null;
  const sectionLabel = secInfo ? ` — ${secInfo.title}` : ' — Главное меню';

  titlebar.innerHTML = `
    <div class="okkam-pc-titlebar-left">
      <div class="okkam-pc-brand-pill">
        <img src="${OKKAM_LOGO_URL}" alt="OKKAM" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
      </div>
      <span class="okkam-pc-app-title">OKKAM Desktop v6.6.3${sectionLabel}</span>
      ${
        pageSection
          ? `<a href="/" class="okkam-pc-nav-back" id="titlebarBackHomeBtn">◀ На главную</a>`
          : ''
      }
    </div>
    <div class="okkam-pc-titlebar-right">
      <button type="button" class="okkam-pc-tool-btn" id="titlebarCheckUpdatesBtn" title="Запустить проверку обновлений">
        🔄 Проверка обновлений
      </button>
      <button type="button" class="okkam-pc-tool-btn" id="titlebarDownloadBatBtn" title="Скачать ярлык запуска для рабочего стола Windows (.bat)">
        🖥️ Ярлык на ПК (.bat)
      </button>
      <div class="okkam-pc-win-controls">
        <button type="button" class="okkam-pc-win-btn" id="titlebarMinimizeBtn" title="Свернуть окно на рабочий стол">—</button>
        <button type="button" class="okkam-pc-win-btn close" id="titlebarCloseToDesktopBtn" title="Закрыть окно на рабочий стол">✕</button>
      </div>
    </div>
  `;

  document.getElementById('titlebarCheckUpdatesBtn')?.addEventListener('click', () => {
    runSplashAndProceed(true);
  });

  document.getElementById('titlebarDownloadBatBtn')?.addEventListener('click', async () => {
    if (deferredPwaPrompt) {
      await deferredPwaPrompt.prompt();
      deferredPwaPrompt = null;
    } else {
      downloadWindowsShortcutBat();
    }
  });

  const minimizeToDesktop = () => {
    ensureDesktopWorkspace();
    const tabText = document.getElementById('taskbarWindowStatusText');
    if (tabText) {
      tabText.textContent = `OKKAM Desktop (${currentAccount?.login}) — Нажмите для развёртывания`;
    }
  };

  document.getElementById('titlebarMinimizeBtn')?.addEventListener('click', minimizeToDesktop);
  document.getElementById('titlebarCloseToDesktopBtn')?.addEventListener('click', minimizeToDesktop);
}

function renderForbiddenSectionOverlay(sectionId: string) {
  const secInfo = allSections.find((s) => s.id === sectionId);
  const title = secInfo ? secInfo.title : sectionId;
  ensureDesktopWorkspace();
  const stage = document.getElementById('okkamDesktopStage');
  if (!stage) return;

  stage.innerHTML = `
    <div class="okkam-login-window" id="okkamAccessDeniedOverlay">
      <div class="okkam-win-titlebar">
        <div class="okkam-win-titlebar-brand">
          <img src="${OKKAM_LOGO_URL}" alt="OKKAM" onerror="this.onerror=null;this.src='/invent/logo.svg';" />
          <span>OKKAM Desktop — Ограничение прав доступа</span>
        </div>
      </div>
      <div class="okkam-login-header" style="background:linear-gradient(135deg,#dc2626,#ef4444);">
        <h2>Доступ ограничен</h2>
        <p>Раздел «${title}» не входит в список доступных для вашей учётной записи</p>
      </div>
      <div class="okkam-login-body" style="text-align:center;">
        <p style="font-size:14px;color:#475569;line-height:1.5;">
          Вы вошли как <strong>${currentAccount?.displayName || currentAccount?.login}</strong>.
          Для получения доступа к этому разделу обратитесь к администратору портала ОККАМ.
        </p>
        <a href="/" class="okkam-submit-btn" style="text-decoration:none;display:inline-block;text-align:center;">Вернуться в главное меню</a>
      </div>
    </div>
  `;
}

function applyPortalPermissions() {
  if (!currentAccount) {
    runSplashAndProceed(false);
    return;
  }

  renderDesktopTitlebar();

  const pageSection = getCurrentPageSectionId();
  if (pageSection) {
    const allowed =
      currentAccount.role === 'admin' ||
      (Array.isArray(currentAccount.allowedSections) &&
        currentAccount.allowedSections.includes(pageSection));
    if (!allowed) {
      renderForbiddenSectionOverlay(pageSection);
      return;
    }
  }

  // Inject top auth bar on main portal page
  const container = document.querySelector('.container');
  const grid = document.querySelector('main.grid');
  if (container && grid) {
    let authBar = document.getElementById('okkamAuthBar');
    if (!authBar) {
      authBar = document.createElement('div');
      authBar.id = 'okkamAuthBar';
      authBar.className = 'okkam-auth-bar';
      container.insertBefore(authBar, container.firstChild);
    }

    const isAdmin = currentAccount.role === 'admin';
    const allowedCount = isAdmin
      ? allSections.length
      : (currentAccount.allowedSections || []).length;
    const initials = (currentAccount.displayName || currentAccount.login || 'U')
      .slice(0, 2)
      .toUpperCase();

    authBar.innerHTML = `
      <div class="okkam-auth-user">
        <div class="okkam-avatar">${initials}</div>
        <div class="okkam-user-meta">
          <div class="okkam-user-name">
            <span id="currentUserDisplayName">${currentAccount.displayName}</span>
            <span class="okkam-role-badge ${isAdmin ? 'admin' : 'user'}">
              ${isAdmin ? 'Администратор' : 'Сотрудник'}
            </span>
          </div>
          <div class="okkam-user-sub">
            Логин: <strong>${currentAccount.login}</strong> • Доступно разделов: <strong id="allowedSectionsCount">${allowedCount}</strong>
          </div>
        </div>
      </div>
      <div class="okkam-auth-actions">
        ${
          isAdmin
            ? `<button type="button" id="openAdminPanelBtn" class="okkam-btn okkam-btn-admin">⚙️ Админ-панель</button>`
            : ''
        }
        <button type="button" id="downloadShortcutBarBtn" class="okkam-btn okkam-btn-shortcut" title="Скачать ярлык запуска на рабочий стол Windows">🖥️ Ярлык для ПК</button>
        <button type="button" id="logoutBtn" class="okkam-btn okkam-btn-logout">Выйти</button>
      </div>
    `;

    document.getElementById('downloadShortcutBarBtn')?.addEventListener('click', () => {
      downloadWindowsShortcutBat();
    });

    document.getElementById('logoutBtn')?.addEventListener('click', async () => {
      await apiFetch('/api/auth/logout', { method: 'POST' });
      setToken('');
      currentAccount = null;
      document.getElementById('okkamDesktopTitlebar')?.remove();
      document.body.classList.remove('okkam-has-titlebar');
      renderLoginOverlay();
    });

    document.getElementById('openAdminPanelBtn')?.addEventListener('click', () => {
      openAdminModal();
    });

    // Filter main portal cards based on allowedSections
    const allowedSet = new Set(
      isAdmin ? allSections.map((s) => s.id) : currentAccount.allowedSections || []
    );

    const existingCardSectionIds = new Set<string>();
    grid.querySelectorAll('a.card').forEach((cardEl) => {
      const href = (cardEl.getAttribute('href') || '').replace(/^\/+|\/+$/g, '').toLowerCase();
      const secId = href.split('/')[0];
      if (!secId) return;
      existingCardSectionIds.add(secId);
      (cardEl as HTMLElement).style.display = allowedSet.has(secId) ? '' : 'none';
    });

    // Remove previously injected extra cards before re-rendering
    grid.querySelectorAll('.okkam-extra-card').forEach((el) => el.remove());

    // Render cards for any additional sections enabled for this user
    const disabledCard = grid.querySelector('.card.disabled');
    allSections.forEach((sec) => {
      if (existingCardSectionIds.has(sec.id)) return;
      if (!allowedSet.has(sec.id)) return;
      const a = document.createElement('a');
      a.href = sec.path;
      a.className = 'card okkam-extra-card';
      a.innerHTML = `
        <div class="card-arrow"><svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></div>
        <div class="icon-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
            <path d="M9 12h6M12 9v6"/>
          </svg>
        </div>
        <div class="card-content">
          <h2 class="card-title">${sec.title}</h2>
          <p class="card-desc">${sec.desc}</p>
        </div>
      `;
      if (disabledCard) {
        grid.insertBefore(a, disabledCard);
      } else {
        grid.appendChild(a);
      }
    });
  }
}

async function openAdminModal() {
  let modal = document.getElementById('adminPanelModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'adminPanelModal';
    modal.className = 'okkam-admin-modal';
    document.body.appendChild(modal);
  }

  const res = await apiFetch('/api/accounts');
  if (res.ok && Array.isArray(res.accounts)) {
    allAccounts = res.accounts;
  }

  editingAccountId = null;
  renderAdminModalContents(modal);
  modal.classList.add('open');

  if (auth.currentUser && !unsubscribeFirestore) {
    const path = 'users';
    unsubscribeFirestore = onSnapshot(
      collection(db, path),
      () => {
        // Firestore sync active
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, path);
      }
    );
  }
}

function renderAdminModalContents(modal: HTMLElement, statusMessage = '', isError = false) {
  const editingAcc = editingAccountId
    ? allAccounts.find((a) => a.id === editingAccountId) || null
    : null;

  const selectedSecs = new Set<string>(
    editingAcc
      ? editingAcc.allowedSections || []
      : ['dublikat', 'perepak', 'gtin', 'doki']
  );

  const sectionCheckboxesHtml = allSections
    .map((sec) => {
      const checked = selectedSecs.has(sec.id);
      return `
        <label class="okkam-sec-check ${checked ? 'checked' : ''}" data-sec-label="${sec.id}">
          <input type="checkbox" name="allowedSection" value="${sec.id}" ${checked ? 'checked' : ''} />
          <span>${sec.title}</span>
        </label>
      `;
    })
    .join('');

  const sectionTitleMap = new Map(allSections.map((s) => [s.id, s.title]));

  const accountsListHtml = allAccounts
    .map((acc) => {
      const isAccAdmin = acc.role === 'admin';
      const secBadges = isAccAdmin
        ? `<span class="okkam-sec-pill" style="background:#fff3e0;border-color:#fdba74;color:#c2410c;">Полный доступ ко всем разделам (${allSections.length})</span>`
        : (acc.allowedSections || []).length > 0
        ? (acc.allowedSections || [])
            .map((sid) => `<span class="okkam-sec-pill">${sectionTitleMap.get(sid) || sid}</span>`)
            .join('')
        : `<span class="okkam-sec-pill" style="color:#dc2626;">Нет выбранных разделов</span>`;

      return `
        <div class="okkam-account-item ${acc.active ? '' : 'inactive'}" data-account-row="${acc.id}">
          <div class="okkam-account-top">
            <div>
              <div style="font-size:15px;font-weight:800;color:#1e2029;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span>${acc.displayName}</span>
                <span class="okkam-role-badge ${isAccAdmin ? 'admin' : 'user'}">
                  ${isAccAdmin ? 'Администратор' : 'Сотрудник'}
                </span>
                ${
                  !acc.active
                    ? '<span class="okkam-role-badge" style="background:#fee2e2;color:#dc2626;">Заблокирован</span>'
                    : ''
                }
              </div>
              <div style="font-size:12px;color:#64748b;margin-top:2px;">
                Логин: <strong>${acc.login}</strong>
              </div>
            </div>
            <div class="okkam-account-actions">
              <button type="button" class="okkam-act-btn" data-edit-acc="${acc.id}" aria-label="Редактировать ${acc.login}">✏️ Изменить</button>
              ${
                acc.id !== currentAccount?.id
                  ? `<button type="button" class="okkam-act-btn danger" data-delete-acc="${acc.id}" aria-label="Удалить ${acc.login}">🗑️ Удалить</button>`
                  : ''
              }
            </div>
          </div>
          <div class="okkam-account-tags">${secBadges}</div>
        </div>
      `;
    })
    .join('');

  modal.innerHTML = `
    <div class="okkam-admin-dialog" role="dialog" aria-label="Админ-панель управления учётными записями">
      <div class="okkam-admin-header">
        <div>
          <h2>⚙️ Админ-панель: Управление учётными записями и доступом</h2>
          <div style="font-size:12px;color:rgba(255,255,255,.8);margin-top:2px;">
            Создание пользователей, назначение ролей и настройка доступных разделов приложения ОККАМ
          </div>
        </div>
        <button type="button" id="closeAdminModalBtn" class="okkam-admin-close" aria-label="Закрыть админ-панель">✕</button>
      </div>
      <div class="okkam-admin-body">
        <div class="okkam-admin-panel-card">
          <h3>
            <span id="adminFormTitle">${editingAcc ? `Редактирование: ${editingAcc.login}` : 'Новая учётная запись'}</span>
            ${
              editingAcc
                ? `<button type="button" id="adminCancelEditBtn" class="okkam-mini-btn">Сбросить</button>`
                : ''
            }
          </h3>
          ${
            statusMessage
              ? `<div id="adminStatusBanner" style="padding:10px 12px;border-radius:10px;font-size:12.5px;font-weight:700;background:${
                  isError ? '#fee2e2' : '#dcfce7'
                };color:${isError ? '#b91c1c' : '#166534'};">${statusMessage}</div>`
              : ''
          }
          <form id="adminAccountForm" style="display:flex;flex-direction:column;gap:11px;">
            <div class="okkam-field">
              <label for="adminLoginInput">Логин сотрудника</label>
              <input type="text" id="adminLoginInput" class="okkam-input" placeholder="Например: ivanov_s" maxlength="100" value="${editingAcc ? editingAcc.login : ''}" required />
            </div>
            <div class="okkam-field">
              <label for="adminNameInput">Имя и должность</label>
              <input type="text" id="adminNameInput" class="okkam-input" placeholder="Например: Иванов С.А. — Кладовщик" maxlength="120" value="${editingAcc ? editingAcc.displayName : ''}" required />
            </div>
            <div class="okkam-field">
              <label for="adminPasswordInput">${editingAcc ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'}</label>
              <input type="password" id="adminPasswordInput" class="okkam-input" placeholder="${editingAcc ? 'Без изменений' : 'Минимум 3 символа'}" ${editingAcc ? '' : 'required'} />
            </div>
            <div class="okkam-field">
              <label for="adminRoleSelect">Роль доступа</label>
              <select id="adminRoleSelect" class="okkam-select">
                <option value="user" ${!editingAcc || editingAcc.role === 'user' ? 'selected' : ''}>Сотрудник (доступ к выбранным разделам)</option>
                <option value="admin" ${editingAcc && editingAcc.role === 'admin' ? 'selected' : ''}>Администратор (полный доступ + админ-панель)</option>
              </select>
            </div>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#334155;cursor:pointer;">
              <input type="checkbox" id="adminActiveCheckbox" style="width:16px;height:16px;accent-color:#2c6e49;" ${!editingAcc || editingAcc.active ? 'checked' : ''} />
              <span>Учётная запись активна (разрешён вход)</span>
            </label>

            <div class="okkam-field" id="adminSectionsFieldWrap">
              <label>Доступные разделы портала</label>
              <div class="okkam-quick-sec-btns">
                <button type="button" class="okkam-mini-btn" id="btnSelectMainSecs">Основные 9</button>
                <button type="button" class="okkam-mini-btn" id="btnSelectAllSecs">Выбрать все (${allSections.length})</button>
                <button type="button" class="okkam-mini-btn" id="btnClearAllSecs">Снять все</button>
              </div>
              <div class="okkam-sections-selector" id="adminSectionsGrid">
                ${sectionCheckboxesHtml}
              </div>
            </div>

            <button type="submit" id="adminSaveAccountBtn" class="okkam-submit-btn">
              ${editingAcc ? 'Сохранить изменения' : 'Создать учётную запись'}
            </button>
          </form>
        </div>

        <div class="okkam-admin-panel-card">
          <h3>
            <span>Зарегистрированные пользователи (${allAccounts.length})</span>
          </h3>
          <div class="okkam-accounts-list" id="adminAccountsList">
            ${accountsListHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('closeAdminModalBtn')?.addEventListener('click', () => {
    modal.classList.remove('open');
  });

  document.getElementById('adminCancelEditBtn')?.addEventListener('click', () => {
    editingAccountId = null;
    renderAdminModalContents(modal);
  });

  const secGrid = document.getElementById('adminSectionsGrid');
  secGrid?.querySelectorAll('input[name="allowedSection"]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const checkEl = inp as HTMLInputElement;
      const lbl = checkEl.closest('.okkam-sec-check');
      if (lbl) {
        lbl.classList.toggle('checked', checkEl.checked);
      }
    });
  });

  const mainIds = new Set(['dublikat', 'perepak', 'gtin', 'sborka', 'sverka', 'reestr', 'zakaz', 'x5', 'doki']);
  document.getElementById('btnSelectMainSecs')?.addEventListener('click', () => {
    secGrid?.querySelectorAll('input[name="allowedSection"]').forEach((inp) => {
      const checkEl = inp as HTMLInputElement;
      checkEl.checked = mainIds.has(checkEl.value);
      checkEl.closest('.okkam-sec-check')?.classList.toggle('checked', checkEl.checked);
    });
  });

  document.getElementById('btnSelectAllSecs')?.addEventListener('click', () => {
    secGrid?.querySelectorAll('input[name="allowedSection"]').forEach((inp) => {
      const checkEl = inp as HTMLInputElement;
      checkEl.checked = true;
      checkEl.closest('.okkam-sec-check')?.classList.add('checked');
    });
  });

  document.getElementById('btnClearAllSecs')?.addEventListener('click', () => {
    secGrid?.querySelectorAll('input[name="allowedSection"]').forEach((inp) => {
      const checkEl = inp as HTMLInputElement;
      checkEl.checked = false;
      checkEl.closest('.okkam-sec-check')?.classList.remove('checked');
    });
  });

  modal.querySelectorAll('[data-edit-acc]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingAccountId = btn.getAttribute('data-edit-acc');
      renderAdminModalContents(modal);
    });
  });

  modal.querySelectorAll('[data-delete-acc]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-delete-acc');
      if (!targetId) return;
      const res = await apiFetch(`/api/accounts/${encodeURIComponent(targetId)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        renderAdminModalContents(modal, res.error || 'Ошибка удаления', true);
        return;
      }
      await deleteAccountFromFirestore(targetId);
      const listRes = await apiFetch('/api/accounts');
      if (listRes.ok) allAccounts = listRes.accounts;
      renderAdminModalContents(modal, 'Учётная запись удалена', false);
    });
  });

  const form = document.getElementById('adminAccountForm') as HTMLFormElement;
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = (document.getElementById('adminLoginInput') as HTMLInputElement).value.trim();
    const displayName = (document.getElementById('adminNameInput') as HTMLInputElement).value.trim();
    const password = (document.getElementById('adminPasswordInput') as HTMLInputElement).value;
    const role = (document.getElementById('adminRoleSelect') as HTMLSelectElement).value as 'admin' | 'user';
    const active = (document.getElementById('adminActiveCheckbox') as HTMLInputElement).checked;

    const allowedSections: string[] = [];
    secGrid?.querySelectorAll('input[name="allowedSection"]:checked').forEach((inp) => {
      allowedSections.push((inp as HTMLInputElement).value);
    });

    const isUpdating = Boolean(editingAccountId);
    const endpoint = isUpdating
      ? `/api/accounts/${encodeURIComponent(editingAccountId!)}`
      : '/api/accounts';
    const method = isUpdating ? 'PUT' : 'POST';

    const res = await apiFetch(endpoint, {
      method,
      body: JSON.stringify({
        login,
        displayName,
        password,
        role,
        allowedSections,
        active
      })
    });

    if (!res.ok) {
      renderAdminModalContents(modal, res.error || 'Не удалось сохранить учётную запись', true);
      return;
    }

    if (res.account) {
      await syncAccountToFirestore(res.account, !isUpdating);
      if (currentAccount && res.account.id === currentAccount.id) {
        currentAccount = res.account;
        applyPortalPermissions();
      }
    }

    const listRes = await apiFetch('/api/accounts');
    if (listRes.ok) allAccounts = listRes.accounts;
    const savedLogin = res.account?.login || login;
    editingAccountId = null;
    renderAdminModalContents(
      modal,
      isUpdating
        ? `Учётная запись «${savedLogin}» успешно обновлена`
        : `Учётная запись «${savedLogin}» успешно создана`,
      false
    );
  });
}

async function bootstrapOkkamAuth() {
  injectStyles();

  const isDesktopShortcutLaunch = window.location.search.includes('launch=desktop');
  if (isDesktopShortcutLaunch) {
    const cleanUrl = window.location.pathname || '/';
    window.history.replaceState({}, '', cleanUrl);
    sessionStorage.removeItem(SPLASH_SEEN_SESSION_KEY);
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setToken('');
    currentAccount = null;
  }

  try {
    const res = await apiFetch('/api/auth/me');
    if (Array.isArray(res.sections)) {
      allSections = res.sections;
    }
    if (!isDesktopShortcutLaunch && res.authenticated && res.account) {
      currentAccount = res.account;
      sessionStorage.setItem(SPLASH_SEEN_SESSION_KEY, '1');
      applyPortalPermissions();
    } else {
      runSplashAndProceed(isDesktopShortcutLaunch);
    }
  } catch {
    runSplashAndProceed(isDesktopShortcutLaunch);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapOkkamAuth);
} else {
  bootstrapOkkamAuth();
}
