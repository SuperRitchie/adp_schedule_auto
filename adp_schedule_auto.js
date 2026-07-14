#!/usr/bin/env node
/*
  ADP/UKG automatic schedule capture + parser runner.

  This script:
  1) Opens ADP/MyADP using Playwright.
  2) Attempts a normal username/password login from .env, if a login form appears.
  3) Attempts to auto-resolve MFA by expanding details, selecting Gmail, and polling the Gmail API for the code.
  4) Navigates to My Work Features, then opens Team Schedule.
  5) Scrolls the virtualized grid to load as many rows as possible.
  6) Saves the schedule HTML.
  7) Runs team_schedule_parser.py to create CSV/JSON and employee .ics files.
*/

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const dotenv = require('dotenv');

let google = null;

loadEnvFiles();

const DEFAULT_START_URL = 'https://my.adp.com/#/time';
const DEFAULT_WORK_FEATURES_URL = 'https://my.adp.com/#/time/myworkfeatures';

// Scopes required for reading emails
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const GOOGLE_SECRETS_DIR = path.resolve(envRaw('GOOGLE_SECRETS_DIR', '.secrets'));
const GOOGLE_CREDENTIALS_PATH = path.resolve(
  envRaw('GOOGLE_CREDENTIALS_PATH', envRaw('GMAIL_CREDENTIALS_PATH', path.join(GOOGLE_SECRETS_DIR, 'gmail_credentials.json')))
);
const GOOGLE_TOKEN_PATH = path.resolve(
  envRaw('GOOGLE_TOKEN_PATH', envRaw('GMAIL_TOKEN_PATH', path.join(GOOGLE_SECRETS_DIR, 'gmail_token.json')))
);
const LEGACY_GOOGLE_CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const LEGACY_GOOGLE_TOKEN_PATH = path.join(__dirname, 'token.json');

function loadEnvFiles() {
  // dotenv normally reads from the current working directory only. That breaks
  // when you run `node path/to/adp_schedule_auto.js` from outside the repo.
  // Load both locations without overriding values that are already set.
  const candidates = [
    path.resolve(__dirname, '.env'),
    path.resolve(process.cwd(), '.env')
  ];
  const seen = new Set();

  for (const envPath of candidates) {
    if (seen.has(envPath)) continue;
    seen.add(envPath);
    if (!fsSync.existsSync(envPath)) continue;
    dotenv.config({ path: envPath, override: false });
    console.log(`Loaded environment variables from ${envPath}`);
  }
}

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[aria-label*="user" i]',
  'input[placeholder*="user" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="login" i]',
  'input[id*="login" i]',
  'input[type="email"]',
  'input[aria-label*="email" i]',
  'input[placeholder*="email" i]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[type="text"]'
];

const PASSWORD_SELECTORS = [
  'input[autocomplete="current-password"]',
  'input[type="password"]',
  'input[aria-label*="password" i]',
  'input[placeholder*="password" i]',
  'input[name*="password" i]',
  'input[id*="password" i]'
];

const USERNAME_LABELS = [/user\s*id/i, /username/i, /email/i, /login/i];
const PASSWORD_LABELS = [/password/i];


function envRaw(name, fallback = '') {
  const value = process.env[name];
  return value !== undefined && value !== null && value !== '' ? value : fallback;
}

function env(name, fallback = '') {
  const value = envRaw(name, fallback);
  return typeof value === 'string' ? value.trim() : value;
}

function decodeBase64Secret(value, label) {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact) return '';
  try {
    return Buffer.from(compact, 'base64').toString('utf8');
  } catch (error) {
    throw new Error(`${label} is set but could not be decoded as base64: ${error.message}`);
  }
}

function credentialEnv(name) {
  // Prefer the base64 variant when present. This avoids shell/dotenv escaping
  // problems for passwords with $, #, quotes, backslashes, spaces, etc.
  const b64Name = `${name}_B64`;
  const b64Value = envRaw(b64Name, '');
  if (b64Value !== '') {
    const decoded = decodeBase64Secret(b64Value, b64Name);
    if (debugEnabled()) {
      console.log(`[debug] Using ${b64Name}; decoded length: ${decoded.length}`);
    }
    return decoded;
  }

  const rawValue = envRaw(name, '');
  if (rawValue !== '' && debugEnabled()) {
    console.log(`[debug] Using raw ${name}; length: ${rawValue.length}`);
  }
  return rawValue;
}

function getGoogleApis() {
  if (google) return google;

  try {
    ({ google } = require('googleapis'));
    return google;
  } catch (error) {
    throw new Error(
      `googleapis is required for Gmail-assisted MFA, but it is not installed. Run npm install in this repo or complete MFA manually. Original error: ${error.message}`
    );
  }
}

function googleRequireRefreshToken() {
  return boolEnv('GOOGLE_REQUIRE_REFRESH_TOKEN', true);
}

function isInvalidGrantError(error) {
  const text = [error?.message, error?.response?.data?.error, error?.response?.data?.error_description]
    .filter(Boolean)
    .join(' ');
  return /invalid[_-]?grant|token has been expired or revoked|bad request/i.test(text);
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function writeJsonFile(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, { encoding: 'utf8', mode: 0o600 });
}

async function resolveGoogleJsonArtifact({ preferredPath, legacyPath, envName, label, required = true }) {
  if (await fileExists(preferredPath)) {
    return { path: preferredPath, source: 'file' };
  }

  if (await fileExists(legacyPath)) {
    return { path: legacyPath, source: 'legacy-file' };
  }

  const encoded = envRaw(envName, '');
  if (encoded) {
    const decoded = decodeBase64Secret(encoded, envName);
    parseJsonText(decoded, label);
    await writeJsonFile(preferredPath, decoded);
    return { path: preferredPath, source: envName };
  }

  if (!required) {
    return { path: preferredPath, source: 'missing' };
  }

  throw new Error(
    `${label} file was not found at ${preferredPath}. Provide ${envName}, create the file locally, or place it at ${legacyPath}.`
  );
}

function boolEnv(name, fallback = false) {
  const value = env(name, String(fallback)).toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(value);
}

function numberEnv(name, fallback) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumberEnv(name, fallback) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getVisibleText(page) {
  return page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
}

function debugEnabled() {
  return boolEnv('ADP_DEBUG', false);
}

function textPreview(text, maxLength = 900) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}...`;
}

function detectMfaOrSecurityCheckpoint(text) {
  const body = String(text || '');
  const patterns = [
    /security checkpoint/i,
    /multi[-\s]?factor/i,
    /multifactor/i,
    /authenticator/i,
    /verification code/i,
    /security code/i,
    /one[-\s]?time (?:passcode|password|code)/i,
    /enter (?:the )?(?:verification|security|authentication) code/i,
    /verify your identity/i,
    /we need to verify/i,
    /send(?:ing)? (?:a )?code/i,
    /try another way/i,
  ];

  const matched = patterns.find(pattern => pattern.test(body));
  return {
    detected: Boolean(matched),
    matched_pattern: matched ? matched.source : null,
    preview: textPreview(body, 700),
  };
}

function decodeBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function collectMessageText(payload) {
  if (!payload) return '';

  const chunks = [];
  if (payload.body && payload.body.data) {
    chunks.push(decodeBase64Url(payload.body.data));
  }

  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      chunks.push(collectMessageText(part));
    }
  }

  return chunks.filter(Boolean).join('\n');
}

function extractAdpCodeFromMessage(message) {
  const headers = Array.isArray(message?.data?.payload?.headers) ? message.data.payload.headers : [];
  const subject = headers.find(header => String(header.name || '').toLowerCase() === 'subject')?.value || '';
  const bodyText = [
    message?.data?.snippet || '',
    subject,
    collectMessageText(message?.data?.payload),
  ].filter(Boolean).join('\n');

  const preferredPatterns = [
    /(?:verification|security|authentication|passcode|one[-\s]?time)\D{0,24}(\d{6})/i,
    /(?:code|otp)\D{0,24}(\d{6})/i,
  ];

  for (const pattern of preferredPatterns) {
    const match = bodyText.match(pattern);
    if (match && match[1]) return match[1];
  }

  const fallback = bodyText.match(/\b(\d{6})\b/);
  return fallback ? fallback[1] : null;
}

function latestOpenPage(context) {
  const openPages = context.pages().filter(page => !page.isClosed());
  return openPages[openPages.length - 1] || null;
}

async function recoverOpenPage(context, page, label) {
  if (page && !page.isClosed()) return page;

  const replacement = latestOpenPage(context);
  if (replacement) {
    console.log(`${label}: the active page closed, switching to the most recent open tab.`);
    return replacement;
  }

  throw new Error(`${label}: the active page closed and no replacement tab was available.`);
}

async function saveDebugSnapshot(page, outputDir, reason, extra = {}) {
  if (!page) return null;

  await fs.mkdir(outputDir, { recursive: true });
  const stamp = timestamp();
  const safeReason = String(reason || 'debug').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const base = `debug_${safeReason}_${stamp}`;
  const htmlPath = path.join(outputDir, `${base}.html`);
  const textPath = path.join(outputDir, `${base}.visible_text.txt`);
  const screenshotPath = path.join(outputDir, `${base}.png`);
  const metadataPath = path.join(outputDir, `${base}.debug.json`);

  const [html, visibleText, title, url] = await Promise.all([
    page.content().catch(error => ``),
    getVisibleText(page),
    page.title().catch(() => ''),
    Promise.resolve(page.url()).catch(() => ''),
  ]);

  await fs.writeFile(htmlPath, html, 'utf8').catch(error => console.warn(`Debug HTML write failed: ${error.message}`));
  await fs.writeFile(textPath, visibleText, 'utf8').catch(error => console.warn(`Debug text write failed: ${error.message}`));
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(error => console.warn(`Debug screenshot failed: ${error.message}`));

  const metadata = {
    captured_at: new Date().toISOString(),
    reason,
    url,
    title,
    visible_text_preview: textPreview(visibleText),
    html_file: htmlPath,
    visible_text_file: textPath,
    screenshot_file: await fileExists(screenshotPath) ? screenshotPath : null,
    ...extra,
  };
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8').catch(error => console.warn(`Debug metadata write failed: ${error.message}`));

  console.log(`Saved debug snapshot: ${metadataPath}`);
  if (metadata.screenshot_file) console.log(`Saved debug screenshot: ${metadata.screenshot_file}`);
  return { htmlPath, textPath, screenshotPath, metadataPath };
}

async function stopTraceIfActive(context, outputDir, label) {
  if (!context) return null;
  await fs.mkdir(outputDir, { recursive: true });
  const tracePath = path.join(outputDir, `trace_${label}_${timestamp()}.zip`);
  await context.tracing.stop({ path: tracePath });
  console.log(`Saved Playwright trace: ${tracePath}`);
  return tracePath;
}

async function locatorVisible(locator, timeout = 750) {
  try {
    return (await locator.count()) > 0 && await locator.first().isVisible({ timeout });
  } catch {
    return false;
  }
}

async function locatorIsFillable(locator, timeout = 750) {
  try {
    if ((await locator.count()) === 0) return false;
    const element = locator.first();
    if (!(await element.isVisible({ timeout }))) return false;

    return await element.evaluate(node => {
      const tag = (node.tagName || '').toLowerCase();
      const role = (node.getAttribute('role') || '').toLowerCase();
      const contentEditable = (node.getAttribute('contenteditable') || '').toLowerCase();

      if (tag === 'textarea') return true;
      if (tag === 'input') {
        const type = (node.getAttribute('type') || 'text').toLowerCase();
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type);
      }
      if (node.isContentEditable || contentEditable === 'true' || role === 'textbox') return true;

      const nested = node.querySelector?.('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, [contenteditable=true], [role=textbox]');
      return Boolean(nested);
    });
  } catch {
    return false;
  }
}

async function firstVisibleInput(page, selectors, timeout = 750) {
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if (await locatorIsFillable(locator, timeout)) return locator;
    }
  }
  return null;
}

async function firstVisibleInputByLabel(page, labels, timeout = 750) {
  for (const frame of page.frames()) {
    for (const label of labels) {
      const locator = frame.getByLabel(label).first();
      if (await locatorIsFillable(locator, timeout)) return locator;
    }
  }
  return null;
}

async function findUsernameInput(page, timeout = 750) {
  return await firstVisibleInput(page, USERNAME_SELECTORS, timeout)
    || await firstVisibleInputByLabel(page, USERNAME_LABELS, timeout);
}

async function findPasswordInput(page, timeout = 750) {
  return await firstVisibleInput(page, PASSWORD_SELECTORS, timeout)
    || await firstVisibleInputByLabel(page, PASSWORD_LABELS, timeout);
}

async function waitForLocator(findFn, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const locator = await findFn();
    if (locator) return locator;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.log(`Timed out waiting for ${description}.`);
  return null;
}

async function describeLocator(locator) {
  return await locator.evaluate(node => {
    const tag = (node.tagName || '').toLowerCase();
    const type = node.getAttribute('type') || '';
    const aria = node.getAttribute('aria-label') || '';
    const labelAttr = node.getAttribute('label') || '';
    const id = node.getAttribute('id') || '';
    const name = node.getAttribute('name') || '';
    return `<${tag}${type ? ` type="${type}"` : ''}${id ? ` id="${id}"` : ''}${name ? ` name="${name}"` : ''}${aria ? ` aria-label="${aria}"` : ''}${labelAttr ? ` label="${labelAttr}"` : ''}>`;
  }).catch(() => 'unknown element');
}

async function readInputValue(locator, timeout = 1000) {
  return await locator.evaluate(node => {
    if ('value' in node) return node.value || '';

    const nested = node.querySelector?.('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, [contenteditable=true], [role=textbox]');
    if (!nested) return '';
    if ('value' in nested) return nested.value || '';
    return nested.textContent || '';
  }, { timeout }).catch(async () => {
    return await locator.inputValue({ timeout }).catch(() => '');
  });
}

function valueLooksFilled(currentValue, expectedValue, label) {
  const current = String(currentValue || '').trim();
  const expected = String(expectedValue || '').trim();

  if (current === expected) return true;

  if (/password/i.test(label) && current.length > 0) return true;

  if (/user/i.test(label) && current.length > 0) return true;

  return false;
}

async function fillInput(page, locator, value, label) {
  console.log(`Filling ${label}...`);

  if (!(await locatorIsFillable(locator, 1000))) {
    const description = await describeLocator(locator);
    throw new Error(`Refusing to fill ${label}: matched ${description}, which is not a text input. The login selectors need adjustment.`);
  }

  await locator.click({ timeout: 5_000 }).catch(() => {});
  await locator.fill(value, { timeout: 5_000 });
  await page.waitForTimeout(300).catch(() => {});

  let currentValue = await readInputValue(locator, 1000);
  if (valueLooksFilled(currentValue, value, label)) return true;

  if (!(await locatorIsFillable(locator, 500))) {
    console.log(`${label} field changed or disappeared after fill(); continuing to the next login step.`);
    return true;
  }

  console.log(`${label} value did not appear to stick; retrying with keyboard events...`);
  await locator.click({ timeout: 5_000 }).catch(() => {});

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+A`).catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(value, { delay: 25 });

  currentValue = await readInputValue(locator, 1000);
  if (!valueLooksFilled(currentValue, value, label)) {
    const description = await describeLocator(locator);
    console.log(`Warning: ${label} may not have filled correctly. Matched ${description}. Continuing so you can finish manually if needed.`);
  }

  return true;
}

async function isLikelyLoggedIn(page) {
  const [text, title] = await Promise.all([
    getVisibleText(page),
    page.title().catch(() => '')
  ]);
  return /Team Schedule|My Calendar|My Timecard|Time - MyADP|Go to Team Schedule/i.test(text)
    || /Time - MyADP/i.test(title);
}

async function waitForLoginFormOrLoggedIn(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isLikelyLoggedIn(page)) return 'logged-in';
    const userInput = await findUsernameInput(page, 250);
    const passInput = await findPasswordInput(page, 250);
    if (userInput || passInput) return 'login-form';
    await page.waitForTimeout(500);
  }
  return 'unknown';
}

async function clickButtonLike(page, patterns, timeout = 1500) {
  for (const frame of page.frames()) {
    for (const pattern of patterns) {
      const roleButton = frame.getByRole('button', { name: pattern }).first();
      if (await locatorVisible(roleButton, timeout)) {
        await roleButton.click();
        return true;
      }

      const roleLink = frame.getByRole('link', { name: pattern }).first();
      if (await locatorVisible(roleLink, timeout)) {
        await roleLink.click();
        return true;
      }

      const textLocator = frame.getByText(pattern).first();
      if (await locatorVisible(textLocator, timeout)) {
        await textLocator.click({ trial: true }).catch(() => {});
        await textLocator.click().catch(async () => {
          const handle = await textLocator.elementHandle().catch(() => null);
          if (!handle) throw new Error('No element handle');
          await handle.evaluate(el => {
            const clickable = el.closest('button,a,[role="button"],ukg-button,adp-button,sdf-button');
            if (clickable) clickable.click();
            else el.click();
          });
        });
        return true;
      }
    }
  }
  return false;
}

async function attemptLogin(page) {
  const username = credentialEnv('ADP_USERNAME');
  const password = credentialEnv('ADP_PASSWORD');
  console.log(`ADP username available: ${Boolean(username)}`);
  console.log(`ADP password available: ${Boolean(password)}`);
  if (!username || !password) {
    console.log('No ADP credentials found in environment. Set ADP_USERNAME/ADP_PASSWORD or ADP_USERNAME_B64/ADP_PASSWORD_B64. Using existing browser session or manual login.');
    return;
  }

  const loginTimeoutMs = Number(env('ADP_LOGIN_TIMEOUT_MS', '45000'));
  console.log(`Waiting up to ${loginTimeoutMs}ms for the ADP login form...`);

  const loginState = await waitForLoginFormOrLoggedIn(page, loginTimeoutMs);
  if (loginState === 'logged-in') {
    console.log('Already past the login screen. Continuing.');
    return;
  }

  if (loginState === 'unknown') {
    console.log('Could not find a login form automatically. Leaving the browser open for manual login if needed.');
    return;
  }

  let userInput = await findUsernameInput(page, 1500);
  let passInput = await findPasswordInput(page, 1500);

  if (userInput) {
    await fillInput(page, userInput, username, 'username');
  } else {
    console.log('Username field was not visible. ADP may have remembered the username or moved to a password-only step.');
  }

  passInput = await findPasswordInput(page, 1500);
  if (!passInput && userInput) {
    const clickedNext = await clickButtonLike(page, [/next/i, /continue/i], 1000).catch(() => false);
    if (clickedNext) {
      await page.waitForTimeout(1500);
      passInput = await waitForLocator(() => findPasswordInput(page, 750), 30_000, 'password field');
    }
  }

  if (passInput) {
    await fillInput(page, passInput, password, 'password');
  } else {
    console.log('Password field was not visible. Complete the remaining login step manually in the browser.');
    return;
  }

  const clickedSignIn = await clickButtonLike(page, [/sign in/i, /log in/i, /login/i, /submit/i, /continue/i], 1500).catch(() => false);
  if (!clickedSignIn) {
    console.log('Could not click the Sign in button automatically. Press it manually in the browser.');
    return;
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

// ============================================================================
// GMAIL API & MFA AUTO-HANDLING FUNCTIONS
// ============================================================================

/**
 * Authenticates with the Gmail API, prompting the user via CLI on the first run.
 */
async function authorizeGmail() {
  const credentialsArtifact = await resolveGoogleJsonArtifact({
    preferredPath: GOOGLE_CREDENTIALS_PATH,
    legacyPath: LEGACY_GOOGLE_CREDENTIALS_PATH,
    envName: 'GOOGLE_CREDENTIALS_JSON_B64',
    label: 'google oauth client credentials',
  });
  const credentials = parseJsonText(await fs.readFile(credentialsArtifact.path, 'utf8'), 'google oauth client credentials');
  const clientConfig = credentials.installed || credentials.web || credentials.desktop;

  if (!clientConfig) {
    const topLevelKeys = Object.keys(credentials || {});
    throw new Error(
      `credentials.json must contain an installed, web, or desktop OAuth client. Found top-level keys: ${topLevelKeys.join(', ') || '(none)'}.
Use a Google OAuth client JSON downloaded from Google Cloud Console, not a service-account key.`
    );
  }

  const { client_secret, client_id, redirect_uris } = clientConfig;
  if (!client_secret || !client_id || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    const keySummary = Object.keys(clientConfig).sort().join(', ') || '(none)';
    throw new Error(
      `credentials.json is missing client_id, client_secret, or redirect_uris for Gmail OAuth. ` +
      `Found keys inside ${credentials.installed ? 'installed' : credentials.web ? 'web' : 'desktop'}: ${keySummary}. ` +
      `Create a Desktop app OAuth client in Google Cloud Console and download its JSON, or add a valid redirect_uris array to the OAuth client config.`
    );
  }

  const googleClient = getGoogleApis();
  const oAuth2Client = new googleClient.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const tokenArtifact = await resolveGoogleJsonArtifact({
    preferredPath: GOOGLE_TOKEN_PATH,
    legacyPath: LEGACY_GOOGLE_TOKEN_PATH,
    envName: 'GOOGLE_TOKEN_JSON_B64',
    label: 'google oauth token',
    required: false,
  });

  try {
    const tokenText = await fs.readFile(tokenArtifact.path, 'utf8');
    const token = parseJsonText(tokenText, 'google oauth token');
    if (googleRequireRefreshToken() && !token.refresh_token) {
      throw new Error(
        'google oauth token is missing refresh_token. Run `npm run gmail:auth` locally and replace GOOGLE_TOKEN_JSON_B64 or the token file.'
      );
    }
    oAuth2Client.setCredentials(token);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return await getNewToken(oAuth2Client);
    }
    throw err;
  }
  return oAuth2Client;
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const code = await ask('Enter the code from that page here: ');
  const { tokens } = await oAuth2Client.getToken(code);
  if (googleRequireRefreshToken() && !tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Revoke the app access in your Google account, confirm the consent screen is in production, and run `npm run gmail:auth` again.'
    );
  }
  oAuth2Client.setCredentials(tokens);
  await writeJsonFile(GOOGLE_TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token stored to', GOOGLE_TOKEN_PATH);
  return oAuth2Client;
}

/**
 * Polls the Gmail API for the latest unread ADP verification code.
 */
async function fetchLatestAdpCode(auth) {
  const googleClient = getGoogleApis();
  const gmail = googleClient.gmail({ version: 'v1', auth });
  const maxAttempts = 12; // Poll for 60 seconds total (5s intervals)
  const query = env('ADP_GMAIL_QUERY', 'from:SecurityServices_NoReply@adp.com newer_than:1d');
  
  console.log('Polling Gmail for the verification code...');

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 5,
      });

      const messages = res.data.messages;
      if (messages && messages.length > 0) {
        for (const message of messages) {
          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full',
          });

          const code = extractAdpCodeFromMessage(msg);
          if (code) {
            console.log(`Successfully extracted ADP code: ${code}`);
            return code;
          }
        }
      }
    } catch (error) {
      if (isInvalidGrantError(error)) {
        throw new Error(
          'Google Gmail authorization failed with invalid_grant. Run `npm run gmail:auth` locally, replace GOOGLE_TOKEN_JSON_B64 or the token file, and try again.'
        );
      }
      throw error;
    }

    // Wait 5 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  return null;
}

/**
 * Navigates the ADP MFA UI and injects the code retrieved from Gmail.
 */
async function autoHandleMfa(page) {
  console.log("Attempting to auto-resolve MFA via Gmail...");

  // 1. Expand the "Show additional details" drawer if it exists
  const showDetailsBtn = page.getByText('Show additional details');
  if (await locatorVisible(showDetailsBtn, 3000)) {
    console.log("Clicking 'Show additional details'...");
    await showDetailsBtn.click();
    await page.waitForTimeout(1000); // Allow drawer to animate open
  }

  // 2. Select the Gmail option
  const gmailOption = page.getByText(/gmail(\.com)?/i).first();
  if (await locatorVisible(gmailOption, 3000)) {
    console.log("Selecting the Gmail delivery option...");
    await gmailOption.click();
  } else {
    throw new Error("Could not find the Gmail option in the MFA prompt.");
  }

  // 3. Wait for the Passcode input field to appear
  const passcodeField = page.getByRole('textbox', { name: /passcode/i }).first();
  await waitForLocator(() => locatorVisible(passcodeField, 1000) ? passcodeField : null, 15000, 'Passcode input field');

  // 4. Retrieve the code via the Gmail API
  const auth = await authorizeGmail();
  const code = await fetchLatestAdpCode(auth);

  if (!code) {
    throw new Error("Failed to retrieve the verification code from Gmail within the timeout.");
  }

  // 5. Enter the code and submit
  console.log("Submitting the code to ADP...");
  await passcodeField.fill(code);
  
  const submitCandidates = [
    page.getByRole('button', { name: /Submit/i }).first(),
    page.getByRole('button', { name: /Continue/i }).first(),
    page.getByRole('button', { name: /Verify/i }).first(),
    page.getByRole('button', { name: /Next/i }).first(),
  ];

  let submitBtn = null;
  for (const candidate of submitCandidates) {
    if (await locatorVisible(candidate, 2000)) {
      submitBtn = candidate;
      break;
    }
  }

  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passcodeField.press('Enter').catch(() => {});
  }
  
  console.log("MFA code submitted successfully.");
}

// ============================================================================

async function waitUntilTimeLandingOrLoggedIn(page) {
  const headless = boolEnv('ADP_HEADLESS', false);
  const timeoutMs = 90_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const text = await getVisibleText(page);
    if (/Team Schedule/i.test(text) || /My Calendar/i.test(text) || /My Timecard/i.test(text) || /Time - MyADP/i.test(await page.title().catch(() => ''))) {
      return;
    }
    const mfaInfo = detectMfaOrSecurityCheckpoint(text);
    if (mfaInfo.detected) {
      if (headless) throw new Error(`ADP is asking for MFA/security checkpoint. Matched: ${mfaInfo.matched_pattern}. Run once with ADP_HEADLESS=false and complete it manually.`);
      console.log('\nADP security checkpoint/MFA detected. Complete it in the browser window.');
      await ask('After the Time landing page appears, press Enter here... ');
      return;
    }
    await page.waitForTimeout(1000);
  }

  if (!headless) {
    console.log('\nI could not confirm login automatically. Complete any remaining login steps in the browser.');
    await ask('When the Time landing page is visible, press Enter here... ');
  } else {
    throw new Error('Could not confirm login in headless mode.');
  }
}

async function getMfaOrSecurityCheckpointInfo(page) {
  const text = await getVisibleText(page);
  return detectMfaOrSecurityCheckpoint(text);
}

async function isMfaOrSecurityCheckpointVisible(page) {
  const info = await getMfaOrSecurityCheckpointInfo(page);
  return info.detected;
}

async function waitForAuthToSettle(page) {
  const headless = boolEnv('ADP_HEADLESS', false);
  const timeoutMs = Number(env('ADP_POST_LOGIN_TIMEOUT_MS', '90000'));
  const outputDir = path.resolve(env('OUTPUT_DIR', 'captures'));
  const start = Date.now();
  let lastDebugLogAt = 0;

  console.log(`Waiting up to ${timeoutMs}ms for ADP login/MFA to settle...`);

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;

    if (await isLikelyLoggedIn(page)) {
      console.log('ADP appears to be past the login screen. Continuing.');
      return;
    }

    const mfaInfo = await getMfaOrSecurityCheckpointInfo(page);
    if (mfaInfo.detected) {
      console.log(`Possible ADP MFA/security checkpoint detected. Matched pattern: ${mfaInfo.matched_pattern}`);
      
      try {
        await autoHandleMfa(page);
        
        // Reset the start timer to give ADP time to load the dashboard post-MFA
        console.log("Waiting for post-MFA redirect...");
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        continue; // Let the while loop check for isLikelyLoggedIn again
        
      } catch (mfaError) {
        console.error(`Automated MFA failed: ${mfaError.message}`);
        
        if (debugEnabled() || headless) {
          await saveDebugSnapshot(page, outputDir, 'mfa_failure', { error: mfaError.message });
        }
        if (headless) throw new Error(`Automated MFA failed in headless mode: ${mfaError.message}`);
        
        console.log('\nFalling back to manual MFA. Complete it in the browser window.');
        await ask('After ADP finishes logging in, press Enter here... ');
        return;
      }
    }

    const userInput = await findUsernameInput(page, 250);
    const passInput = await findPasswordInput(page, 250);
    if (!userInput && !passInput) {
      await page.waitForTimeout(1500);
      console.log('Login fields disappeared. Continuing to the next ADP page.');
      return;
    }

    if (debugEnabled() && elapsed - lastDebugLogAt >= 5000) {
      lastDebugLogAt = elapsed;
      const text = await getVisibleText(page);
      console.log(`[debug] auth wait ${Math.round(elapsed / 1000)}s url=${page.url()}`);
      console.log(`[debug] auth page preview: ${textPreview(text, 350)}`);
    }

    await page.waitForTimeout(750);
  }

  if (!headless) {
    console.log('\nI could not confirm that ADP finished logging in automatically. Complete any remaining login/MFA step in the browser.');
    await ask('When ADP is past the login screen, press Enter here... ');
  } else {
    if (debugEnabled() || headless) await saveDebugSnapshot(page, outputDir, 'auth_timeout');
    throw new Error('Could not confirm ADP login in headless mode. Check the uploaded adp-debug-artifacts artifact for a screenshot/HTML of what GitHub Actions saw.');
  }
}

async function navigateToWorkFeaturesPage(page, context) {
  if (env('TEAM_SCHEDULE_URL')) return page;

  const workFeaturesUrl = env('ADP_WORK_FEATURES_URL', DEFAULT_WORK_FEATURES_URL);
  if (!workFeaturesUrl) return page;

  console.log(`Navigating to ADP My Work Features page: ${workFeaturesUrl}`);
  await page.goto(workFeaturesUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  if (context) {
    page = await recoverOpenPage(context, page, 'ADP Work Features navigation');
  }
  await page.waitForTimeout(3000);
  return page;
}

async function pageShowsForbidden(page) {
  const [title, text] = await Promise.all([
    page.title().catch(() => ''),
    getVisibleText(page),
  ]);
  return /\b403\b/.test(title) || /\b403\s+Forbidden\b/i.test(text);
}

async function restoreWorkFeaturesPage(page, context) {
  const workFeaturesUrl = env('ADP_WORK_FEATURES_URL', DEFAULT_WORK_FEATURES_URL);
  const openPages = context.pages().filter(candidate => !candidate.isClosed());
  let workFeaturesPage = openPages.find(candidate => /my\.adp\.com/i.test(candidate.url())) || null;

  if (!workFeaturesPage) {
    workFeaturesPage = page && !page.isClosed() ? page : await context.newPage();
  }

  await workFeaturesPage.bringToFront().catch(() => {});
  if (!/my\.adp\.com/i.test(workFeaturesPage.url())) {
    await workFeaturesPage.goto(workFeaturesUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  } else if (!/myworkfeatures/i.test(workFeaturesPage.url())) {
    await workFeaturesPage.goto(workFeaturesUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  }
  await workFeaturesPage.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await workFeaturesPage.waitForTimeout(3000);
  return workFeaturesPage;
}

async function navigateToTeamSchedule(page, context) {
  page = await recoverOpenPage(context, page, 'ADP Team Schedule navigation');

  const directUrl = env('TEAM_SCHEDULE_URL');
  if (directUrl) {
    console.log(`Going directly to TEAM_SCHEDULE_URL: ${directUrl}`);
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    page = await recoverOpenPage(context, page, 'ADP Team Schedule navigation');
    if (await pageShowsForbidden(page)) {
      throw new Error('UKG/Kronos returned 403 Forbidden for TEAM_SCHEDULE_URL');
    }
    return page;
  }

  const text = env('TEAM_SCHEDULE_TEXT', 'Team Schedule');
  const launchAttempts = numberEnv('ADP_TEAM_SCHEDULE_LAUNCH_ATTEMPTS', 3);
  const launchRetryDelayMs = numberEnv('ADP_TEAM_SCHEDULE_LAUNCH_RETRY_DELAY_MS', 15000);
  let workFeaturesPage = page;

  for (let attempt = 1; attempt <= launchAttempts; attempt += 1) {
    workFeaturesPage = await restoreWorkFeaturesPage(workFeaturesPage, context);
    console.log(`Looking for Team Schedule tile/button: ${text} (launch attempt ${attempt}/${launchAttempts})`);

    const popupPromise = workFeaturesPage.waitForEvent('popup', { timeout: 7000 }).catch(() => null);
    const clicked = await clickButtonLike(workFeaturesPage, [new RegExp(`Go to\\s+${text}`, 'i'), new RegExp(text, 'i')], 1500);
    if (!clicked) {
      const body = await getVisibleText(workFeaturesPage);
      throw new Error(`Could not find/click Team Schedule. Current page text starts with:\n${body.slice(0, 800)}`);
    }

    const popup = await popupPromise;
    let schedulePage = popup || workFeaturesPage;
    if (popup) {
      console.log('Team Schedule opened a new tab/window. Switching to it.');
    }

    await schedulePage.waitForLoadState('domcontentloaded', { timeout: 90_000 }).catch(() => {});
    await schedulePage.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    schedulePage = await recoverOpenPage(context, schedulePage, 'ADP Team Schedule navigation');
    await schedulePage.waitForTimeout(5000);

    if (!(await pageShowsForbidden(schedulePage))) {
      return schedulePage;
    }

    console.warn(`UKG/Kronos returned 403 Forbidden on Team Schedule launch attempt ${attempt}/${launchAttempts}`);
    if (popup && !popup.isClosed()) {
      await popup.close().catch(() => {});
    }

    if (attempt < launchAttempts) {
      const delayMs = launchRetryDelayMs * attempt;
      console.log(`Waiting ${delayMs}ms before relaunching Team Schedule from ADP`);
      await workFeaturesPage.waitForTimeout(delayMs);
    }
  }

  throw new Error(`UKG/Kronos returned 403 Forbidden after ${launchAttempts} Team Schedule launch attempts`);
}


async function readScheduleDateRange(page) {
  const text = await getVisibleText(page);
  const match = text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\b/);
  return match ? match[0] : '';
}

async function waitForScheduleGridReady(page) {
  const timeoutMs = Number(env('ADP_SCHEDULE_READY_TIMEOUT_MS', '45000'));
  await page.waitForSelector('.ag-header-cell[col-id="name"], .ag-center-cols-container div[role="row"], text=/Name\\s*\\[\\d+\\]/', {
    timeout: timeoutMs,
  }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function getLocationJobsLabel(page) {
  const locator = page.locator('button#location-schedule-jobs-selector, [automation-id="location-schedule-jobs-selector"] button').first();
  return cleanOneLine(await locator.innerText({ timeout: 2000 }).catch(() => ''));
}

function cleanOneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function ensureAllLocationsAndJobsSelected(page) {
  if (!boolEnv('ADP_SELECT_ALL_JOBS', true)) return;

  const delayMs = Number(env('ADP_FILTER_DELAY_MS', '700'));
  console.log('Ensuring all Locations and jobs are selected...');

  const dropdownButton = page.locator('button#location-schedule-jobs-selector, [automation-id="location-schedule-jobs-selector"] button').first();
  if (!(await locatorVisible(dropdownButton, 5000))) {
    console.warn('Could not find the Locations and jobs dropdown. Continuing with the current selection.');
    return;
  }

  const beforeLabel = await getLocationJobsLabel(page);
  await dropdownButton.click({ timeout: 10000 });
  await page.waitForTimeout(delayMs);

  let clickedSelectAll = false;
  const selectAllByRole = page.getByRole('button', { name: /Select All/i }).first();
  if (await locatorVisible(selectAllByRole, 3000)) {
    await selectAllByRole.click({ timeout: 10000 });
    clickedSelectAll = true;
  } else {
    const selectAllFallback = page.locator('button.helperButton').filter({ hasText: /Select All/i }).first();
    if (await locatorVisible(selectAllFallback, 3000)) {
      await selectAllFallback.click({ timeout: 10000 });
      clickedSelectAll = true;
    }
  }

  if (!clickedSelectAll) {
    console.warn('Could not find the Select All button in Locations and jobs. Continuing with the current selection.');
    await page.keyboard.press('Escape').catch(() => {});
    return;
  }

  await page.waitForTimeout(delayMs);

  const applyButton = page.locator('button.multi-select-apply-button, button[title="Apply"]').filter({ hasText: /Apply/i }).first();
  if (await locatorVisible(applyButton, 3000)) {
    const isEnabled = await applyButton.isEnabled().catch(() => false);
    if (isEnabled) {
      await applyButton.click({ timeout: 10000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }

  await page.waitForTimeout(delayMs + 1000);
  await waitForScheduleGridReady(page);
  const afterLabel = await getLocationJobsLabel(page);
  console.log(`Locations/jobs filter updated: ${beforeLabel || 'unknown'} -> ${afterLabel || 'unknown'}.`);
}


function selectedJobsCountFromLabel(label) {
  const text = cleanOneLine(label);
  const match = text.match(/\b(\d+)\s+jobs?\s+selected\b/i);
  if (match) return Number.parseInt(match[1], 10);
  if (/\bnone selected\b/i.test(text)) return 0;
  return null;
}

async function validateScheduleCaptureReady(page) {
  const dateRange = await readScheduleDateRange(page);
  const jobsLabel = await getLocationJobsLabel(page);
  const selectedJobsCount = selectedJobsCountFromLabel(jobsLabel);
  const visibleText = await getVisibleText(page);
  const employeeCountMatch = visibleText.match(/\bName\s*\[\s*(\d+)\s*\]/i);
  const employeeCount = employeeCountMatch ? Number.parseInt(employeeCountMatch[1], 10) : 0;
  const minimumEmployees = Number(env('ADP_MIN_EXPECTED_EMPLOYEES', '20'));

  const problems = [];
  if (!dateRange) problems.push('schedule date range is missing');
  if (selectedJobsCount === 0) problems.push(`locations/jobs filter is ${jobsLabel || 'empty'}`);
  if (employeeCount < minimumEmployees) problems.push(`employee header count is ${employeeCount}, below minimum ${minimumEmployees}`);

  if (problems.length) {
    throw new Error(`Schedule page is not ready for capture: ${problems.join('; ')}. This attempt will be retried from a fresh browser session.`);
  }

  return { dateRange, jobsLabel, selectedJobsCount, employeeCount };
}

async function clickNextScheduleWeek(page) {
  const beforeRange = await readScheduleDateRange(page);
  const timeoutMs = Number(env('ADP_NEXT_WEEK_TIMEOUT_MS', '45000'));
  const delayMs = Number(env('ADP_NEXT_WEEK_DELAY_MS', '1000'));

  console.log('Clicking Next to move to the following schedule week...');

  const selectors = [
    '#calendarNavigationNextAction button',
    'button[aria-label="Next Week"]',
    '[title="Next Week"] button',
  ];

  let clicked = false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locatorVisible(locator, 1500)) {
      await locator.click({ timeout: 10000 });
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    clicked = await clickButtonLike(page, [/Next Week/i, /^Next$/i], 1500).catch(() => false);
  }

  if (!clicked) throw new Error('Could not find/click the Next Week button.');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(500);
    const currentRange = await readScheduleDateRange(page);
    if (currentRange && currentRange !== beforeRange) {
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(delayMs);
      await waitForScheduleGridReady(page);
      console.log(`Now viewing schedule week: ${currentRange}`);
      return currentRange;
    }
  }

  throw new Error(`Clicked Next Week, but the date range did not change within ${timeoutMs}ms. Previous range: ${beforeRange || 'unknown'}`);
}

async function collectVirtualGridRows(page) {
  console.log('Collecting all rendered schedule rows while scrolling the virtualized grid...');

  const result = await page.evaluate(async ({ delayMs }) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const rows = new Map();

    function cleanText(value) {
      return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function getExpectedEmployeeCount() {
      const headerText = cleanText(
        document.querySelector('.ag-header-cell[col-id="name"]')?.textContent
        || document.body?.innerText
        || ''
      );
      const match = headerText.match(/Name\s*\[(\d+)\]/i);
      return match ? Number(match[1]) : null;
    }

    function rowName(row) {
      return cleanText(
        row.querySelector('[col-id="name"] .location-schedule-employee-cell__name')?.textContent
        || row.querySelector('[col-id="name"]')?.textContent
        || ''
      );
    }

    function rowPrimaryJob(row) {
      return cleanText(
        row.querySelector('[col-id="primaryJob"] primary-job-cell span')?.textContent
        || row.querySelector('[col-id="primaryJob"] .ag-cell-text > span')?.textContent
        || row.querySelector('[col-id="primaryJob"] .ag-cell-text')?.childNodes?.[0]?.textContent
        || row.querySelector('[col-id="primaryJob"]')?.textContent
        || ''
      );
    }

    function rowSortIndex(row) {
      const raw = row.getAttribute('row-index') || '';
      if (raw === 't-0') return -1;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : 999999;
    }

    function getDayCell(entity) {
      return entity?.closest?.('[col-id^="day-"]') || null;
    }

    function shiftTitle(entity) {
      return cleanText(entity?.querySelector('.location-schedule-cell__title')?.textContent || entity?.textContent || '');
    }

    function rowShiftTargets(row) {
      return Array.from(row.querySelectorAll('.location-schedule-cell__entity, [automation-id^="location_schedule_cell_shift_"]'))
        .map((entity, index) => {
          const title = shiftTitle(entity);
          const dayCol = getDayCell(entity)?.getAttribute('col-id') || '';
          const automationId = entity.getAttribute('automation-id') || '';
          const shiftId = automationId.replace('location_schedule_cell_shift_', '') || `${dayCol}-${index}`;
          return { index, title, dayCol, automationId, shiftId };
        })
        .filter(item => item.title);
    }

    function rowKey(row) {
      const name = rowName(row);
      const primaryJob = rowPrimaryJob(row);
      const employeeId = row.querySelector('[automation-id^="location_schedule_employee_cell_"]')?.getAttribute('automation-id') || '';
      return [name.toLowerCase(), primaryJob.toLowerCase(), employeeId].join('|');
    }

    function collectVisibleRows(reason) {
      const selector = '.ag-floating-top-container > div[role="row"], .ag-center-cols-container > div[role="row"]';
      for (const row of document.querySelectorAll(selector)) {
        const name = rowName(row);
        if (!name) continue;

        const primaryJob = rowPrimaryJob(row);
        const key = rowKey(row);
        const shifts = rowShiftTargets(row);
        const existing = rows.get(key);
        const candidate = {
          key,
          name,
          primaryJob,
          rowId: row.getAttribute('row-id') || '',
          rowIndex: row.getAttribute('row-index') || '',
          sortIndex: rowSortIndex(row),
          shiftCount: shifts.length,
          shifts,
          reason,
          html: row.outerHTML,
        };

        if (!existing || candidate.shiftCount > existing.shiftCount || candidate.html.length > existing.html.length) {
          rows.set(key, candidate);
        }
      }
    }

    function visibleRowStats() {
      const visibleRows = Array.from(document.querySelectorAll('.ag-floating-top-container > div[role="row"], .ag-center-cols-container > div[role="row"]'))
        .map(row => ({ name: rowName(row), primaryJob: rowPrimaryJob(row), sortIndex: rowSortIndex(row) }))
        .filter(row => row.name);
      const indexes = visibleRows.map(row => row.sortIndex).filter(index => Number.isFinite(index) && index >= 0 && index < 999999);
      return {
        firstVisibleName: visibleRows[0]?.name || '',
        lastVisibleName: visibleRows[visibleRows.length - 1]?.name || '',
        minVisibleIndex: indexes.length ? Math.min(...indexes) : null,
        maxVisibleIndex: indexes.length ? Math.max(...indexes) : null,
      };
    }

    function scoreScroller(el) {
      if (!el) return -1;
      const rect = el.getBoundingClientRect();
      const overflow = Math.max(0, el.scrollHeight - el.clientHeight);
      if (overflow < 20 || rect.width < 300 || rect.height < 150) return -1;
      const className = String(el.className || '');
      let score = overflow;
      if (/ag-body-vertical-scroll-viewport/.test(className)) score += 100000;
      if (/ag-body-viewport/.test(className)) score += 80000;
      if (/ag-center-cols-viewport/.test(className)) score += 60000;
      if (el.querySelector?.('.ag-center-cols-container, div[role="row"]')) score += 20000;
      return score;
    }

    function gridScroller() {
      const candidates = [
        ...document.querySelectorAll('.ag-body-vertical-scroll-viewport, .ag-body-viewport, .ag-center-cols-viewport'),
        ...Array.from(document.querySelectorAll('*')).filter(el => {
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY || '') && el.scrollHeight > el.clientHeight + 80;
        })
      ];
      const seen = new Set();
      return candidates
        .filter(el => {
          if (!el || seen.has(el)) return false;
          seen.add(el);
          return scoreScroller(el) > 0;
        })
        .sort((a, b) => scoreScroller(b) - scoreScroller(a))[0] || null;
    }

    function isComplete(expectedEmployeeCount) {
      const sorted = Array.from(rows.values());
      const realIndexes = sorted.map(row => row.sortIndex).filter(index => index >= 0 && index < 999999);
      const maxSortIndex = realIndexes.length ? Math.max(...realIndexes) : null;
      const uniqueCount = sorted.length;
      if (!expectedEmployeeCount) return false;
      // my schedule is usually pinned at row-index t-0 and still counted in the header
      const targetLastIndex = Math.max(0, expectedEmployeeCount - 2);
      return uniqueCount >= expectedEmployeeCount && maxSortIndex !== null && maxSortIndex >= targetLastIndex;
    }

    const expectedEmployeeCount = getExpectedEmployeeCount();
    const scroller = gridScroller();
    window.scrollTo(0, 0);
    await sleep(delayMs);

    if (!scroller) {
      collectVisibleRows('no-scroller');
      const rowsOut = Array.from(rows.values()).sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));
      return {
        expectedEmployeeCount,
        rowCount: rowsOut.length,
        rows: rowsOut,
        complete: !expectedEmployeeCount || rowsOut.length >= expectedEmployeeCount,
        usedScroller: null,
        scrollStats: visibleRowStats(),
      };
    }

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(delayMs * 2);
    collectVisibleRows('top');

    let previousKey = '';
    let stablePasses = 0;
    let pass = 0;
    const maxPasses = 260;
    const step = Math.max(80, Math.floor(scroller.clientHeight * 0.35));

    while (pass < maxPasses) {
      pass += 1;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const current = Math.max(0, scroller.scrollTop || 0);
      const next = Math.min(max, current + step);
      if (next <= current && current < max) {
        scroller.scrollTop = Math.min(max, current + 80);
      } else {
        scroller.scrollTop = next;
      }
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(delayMs);
      collectVisibleRows(`scroll-pass:${pass}:${Math.round(scroller.scrollTop)}`);

      const stats = visibleRowStats();
      const rowsOut = Array.from(rows.values());
      const realIndexes = rowsOut.map(row => row.sortIndex).filter(index => index >= 0 && index < 999999);
      const maxSortIndex = realIndexes.length ? Math.max(...realIndexes) : null;
      const stateKey = [rowsOut.length, maxSortIndex, Math.round(scroller.scrollTop), Math.round(max), stats.lastVisibleName].join('|');
      if (stateKey === previousKey) stablePasses += 1;
      else stablePasses = 0;
      previousKey = stateKey;

      const atBottom = Math.abs(max - scroller.scrollTop) < 3;
      if (isComplete(expectedEmployeeCount) && atBottom && stablePasses >= 2) break;

      if (atBottom && stablePasses >= 6) {
        // wheel nudges help ag grid render the final virtual rows even when scrolltop is already maxed
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: 900, bubbles: true, cancelable: true }));
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 900, bubbles: true, cancelable: true }));
        await sleep(delayMs);
        collectVisibleRows(`bottom-nudge:${pass}`);
        if (isComplete(expectedEmployeeCount)) break;
      }
    }

    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(delayMs * 2);
    collectVisibleRows('bottom');

    const sortedRows = Array.from(rows.values()).sort((a, b) => {
      if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
      return a.name.localeCompare(b.name) || a.primaryJob.localeCompare(b.primaryJob);
    });
    const realIndexes = sortedRows.map(row => row.sortIndex).filter(index => index >= 0 && index < 999999);
    const maxSortIndex = realIndexes.length ? Math.max(...realIndexes) : null;

    return {
      expectedEmployeeCount,
      rowCount: sortedRows.length,
      rows: sortedRows,
      complete: !expectedEmployeeCount || (sortedRows.length >= expectedEmployeeCount && maxSortIndex !== null && maxSortIndex >= Math.max(0, expectedEmployeeCount - 2)),
      maxSortIndex,
      usedScroller: {
        className: scroller.className || '',
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        step,
      },
      scrollStats: visibleRowStats(),
    };
  }, { delayMs: Number(env('ADP_SCROLL_DELAY_MS', '500')) });

  console.log(`Collected ${result.rowCount} rendered schedule rows${result.expectedEmployeeCount ? `; header expects ${result.expectedEmployeeCount}` : ''}${result.maxSortIndex !== undefined && result.maxSortIndex !== null ? `; max row-index ${result.maxSortIndex}` : ''}${result.scrollStats?.lastVisibleName ? `; last visible ${result.scrollStats.lastVisibleName}` : ''}.`);
  if (result.expectedEmployeeCount && !result.complete) {
    console.warn(`WARNING: collected ${result.rowCount} rows, but the header expects ${result.expectedEmployeeCount}. Last visible row was ${result.scrollStats?.lastVisibleName || 'unknown'}. Try increasing ADP_SCROLL_DELAY_MS.`);
  }

  await page.waitForTimeout(1000);
  return result;
}

function shiftDetailEnabled() {
  return boolEnv('ADP_CAPTURE_SHIFT_DETAILS', false);
}

async function resetScheduleGridToTop(page, waitMs = Number(env('ADP_SCROLL_DELAY_MS', '1000'))) {
  await page.evaluate(() => {
    function scoreScroller(el) {
      if (!el) return -1;
      const rect = el.getBoundingClientRect();
      const overflow = Math.max(0, el.scrollHeight - el.clientHeight);
      if (overflow < 20 || rect.width < 300 || rect.height < 150) return -1;
      const className = String(el.className || '');
      let score = overflow;
      if (/ag-body-vertical-scroll-viewport/.test(className)) score += 100000;
      if (/ag-body-viewport/.test(className)) score += 80000;
      if (/ag-center-cols-viewport/.test(className)) score += 60000;
      return score;
    }
    const candidates = [
      ...document.querySelectorAll('.ag-body-vertical-scroll-viewport, .ag-body-viewport, .ag-center-cols-viewport'),
      ...Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowY || '') && el.scrollHeight > el.clientHeight + 80;
      })
    ];
    const seen = new Set();
    const scroller = candidates
      .filter(el => {
        if (!el || seen.has(el)) return false;
        seen.add(el);
        return scoreScroller(el) > 0;
      })
      .sort((a, b) => scoreScroller(b) - scoreScroller(a))[0] || null;
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, bubbles: true, cancelable: true }));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(waitMs);
}

async function installAutoShiftDetailRuntime(page) {
  await page.evaluate(({ delayMs }) => {
    if (window.__adpAutoShiftDetailRuntimeInstalled) return;
    window.__adpAutoShiftDetailRuntimeInstalled = true;
    window.__adpAutoDetailDelayMs = delayMs;
    window.__adpAutoOverlaySnapshots = [];
    window.__adpAutoRecordedDetails = [];
    window.__adpAutoLastClickedEntity = null;
    window.__adpAutoLastClickToken = 0;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function cleanText(value) {
      return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }

    function compactText(value) {
      return cleanText(value).replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function getRow(entity) {
      return entity?.closest?.('div[role="row"]') || null;
    }

    function getDayCell(entity) {
      return entity?.closest?.('[col-id^="day-"]') || null;
    }

    function entityFromTarget(target) {
      if (!target || !(target instanceof Element)) return null;
      return target.closest('.location-schedule-cell__entity, [automation-id^="location_schedule_cell_shift_"]');
    }

    function storedRecordForTarget(targetId) {
      const id = String(targetId || '');
      if (!id) return null;
      const matches = (window.__adpAutoRecordedDetails || [])
        .filter(item => item?.kind === 'shift-detail-record' && item.targetId === id && item.detailText)
        .sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
      return matches[0] || null;
    }

    function rememberRecordedDetail(item) {
      if (!item) return item;
      window.__adpAutoRecordedDetails.push(item);
      if (window.__adpAutoRecordedDetails.length > 500) {
        window.__adpAutoRecordedDetails.splice(0, window.__adpAutoRecordedDetails.length - 500);
      }
      return item;
    }

    function baseMeta(entity) {
      const row = getRow(entity);
      const dayCell = getDayCell(entity);
      const name = compactText(row?.querySelector('[col-id="name"] .location-schedule-employee-cell__name')?.textContent || row?.querySelector('[col-id="name"]')?.textContent || '');
      const primaryJob = compactText(
        row?.querySelector('[col-id="primaryJob"] primary-job-cell span')?.textContent
        || row?.querySelector('[col-id="primaryJob"] .ag-cell-text > span')?.textContent
        || row?.querySelector('[col-id="primaryJob"] .ag-cell-text')?.childNodes?.[0]?.textContent
        || row?.querySelector('[col-id="primaryJob"]')?.textContent
        || ''
      );
      const shiftTitle = compactText(entity?.querySelector('.location-schedule-cell__title')?.textContent || entity?.textContent || '');
      const automationId = entity?.getAttribute('automation-id') || '';
      return {
        employeeName: name,
        primaryJob,
        rowId: row?.getAttribute('row-id') || '',
        rowIndex: row?.getAttribute('row-index') || '',
        dayCol: dayCell?.getAttribute('col-id') || '',
        shiftTitle,
        shiftId: automationId.replace('location_schedule_cell_shift_', '') || automationId,
      };
    }

    function textTimeCount(text) {
      const matches = compactText(text).match(/\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M/gi);
      return matches ? matches.length : 0;
    }

    function rejectElement(el) {
      if (!el || !(el instanceof Element)) return true;
      const tag = el.tagName.toLowerCase();
      if (['html', 'body', 'script', 'style', 'link', 'meta', 'svg', 'path'].includes(tag)) return true;
      if (el.closest('nav, header, .navbar-nav, .navmenu, .actionBar, .toolbar-dropdown, .checkboxLayer, isteven-multi-select')) return true;
      const cls = String(el.className || '');
      const overlayClass = /(popover|tooltip|overlay|modal|dialog|flyout|floating|schedule).*?(detail|tooltip|popover|popup)|cdk-overlay|ngb-popover|uib-popover|ukg-popover/i.test(cls);
      const badGridClass = /\bag-(center|body|row|cell|viewport|pinned|root|header|layout|virtual|floating|full-width)\b/.test(cls);
      if (badGridClass && !overlayClass) return true;
      if (el.matches('[role="row"], [role="grid"], [role="gridcell"], .ag-row, .ag-cell, .ag-center-cols-container, .ag-body-viewport, .ag-root, .ag-root-wrapper')) return true;
      if (el.querySelectorAll('.location-schedule-cell__entity, [automation-id^="location_schedule_cell_shift_"]').length > 2 && !overlayClass) return true;
      return false;
    }

    function candidateElements(reason) {
      const candidates = [];
      for (const el of document.querySelectorAll('*')) {
        if (!isVisible(el) || rejectElement(el)) continue;
        const text = cleanText(el.innerText || el.textContent || '');
        const compact = compactText(text);
        if (compact.length < 20 || compact.length > 2600) continue;
        if (!/\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M/i.test(compact)) continue;
        const rect = el.getBoundingClientRect();
        candidates.push({
          reason,
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          text,
          compact,
          html: el.outerHTML,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          timeCount: textTimeCount(compact),
        });
      }
      return candidates;
    }

    function scoreCandidate(item, meta) {
      let score = 0;
      const text = item.compact || compactText(item.text || '');
      if (meta.employeeName && text.includes(meta.employeeName)) score += 60;
      const shiftTime = String(meta.shiftTitle || '').match(/\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || '';
      if (shiftTime && text.includes(shiftTime)) score += 80;
      if (/\b\d+\.\s*\d{1,2}:\d{2}\s*[AP]M/i.test(text)) score += 80;
      if (/\b(Transfer|Break|Meal|MEC\/English|Retail Floor|Cash|Frontline|Inventory|Cycling|Watersports|Climb)\b/i.test(text)) score += 55;
      if (item.timeCount >= 2) score += 30;
      if (/popover|tooltip|overlay|dialog|floating/i.test(item.className || '')) score += 30;
      if (text.length > 120) score += 20;
      if (text.length > 2200) score -= 60;
      return score;
    }

    function recordOverlaySnapshot(reason) {
      const meta = window.__adpAutoLastClickedEntity ? baseMeta(window.__adpAutoLastClickedEntity) : {};
      const token = window.__adpAutoLastClickToken || 0;
      const snapshots = candidateElements(reason).map(item => ({
        ...item,
        token,
        score: scoreCandidate(item, meta),
        capturedAt: new Date().toISOString(),
      }));
      window.__adpAutoOverlaySnapshots.push(...snapshots);
      if (window.__adpAutoOverlaySnapshots.length > 120) {
        window.__adpAutoOverlaySnapshots.splice(0, window.__adpAutoOverlaySnapshots.length - 120);
      }
      return snapshots;
    }

    let snapshotQueued = false;
    function queueOverlaySnapshot(reason) {
      if (snapshotQueued) return;
      snapshotQueued = true;
      requestAnimationFrame(() => {
        snapshotQueued = false;
        recordOverlaySnapshot(reason);
      });
    }

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length) {
          queueOverlaySnapshot('mutation');
          return;
        }
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          queueOverlaySnapshot('attribute');
          return;
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden', 'hidden'],
    });

    function bestDetailCandidate(entity, token) {
      const meta = baseMeta(entity);
      const entityText = compactText(entity?.textContent || '');
      const liveCandidates = candidateElements('live')
        .filter(item => item.compact !== entityText)
        .map(item => ({ ...item, score: scoreCandidate(item, meta), source: 'live' }));
      const snapshotCandidates = (window.__adpAutoOverlaySnapshots || [])
        .filter(item => !token || !item.token || item.token === token)
        .map(item => ({ ...item, score: scoreCandidate(item, meta), source: 'snapshot' }));
      const candidates = [...liveCandidates, ...snapshotCandidates]
        .filter(item => item.score >= 80)
        .sort((a, b) => b.score - a.score || b.compact.length - a.compact.length);
      return candidates[0] || null;
    }

    function attachDetail(entity, detailText) {
      if (!entity || !detailText) return '';
      entity.setAttribute('data-adp-shift-detail', detailText);
      entity.setAttribute('data-adp-auto-shift-detail', detailText);
      const row = getRow(entity);
      return row ? row.outerHTML : '';
    }

    async function captureEntity(entity, kind, options = {}) {
      if (!entity) return { kind: `${kind}-miss`, message: 'no shift entity found' };
      const token = options.token || Number(entity.getAttribute('data-adp-auto-click-token') || '') || window.__adpAutoLastClickToken || 0;
      const targetId = entity.getAttribute('data-adp-auto-shift-target') || '';
      const meta = baseMeta(entity);
      const sampleDelays = [0, 10, 25, 50, 100, 180, 300, Number(window.__adpAutoDetailDelayMs || 800)];
      let best = null;
      let elapsed = 0;

      recordOverlaySnapshot('capture-start');
      for (const waitMs of sampleDelays) {
        const delta = Math.max(0, waitMs - elapsed);
        if (delta) await sleep(delta);
        elapsed = waitMs;
        recordOverlaySnapshot(`capture-${waitMs}`);
        const current = bestDetailCandidate(entity, token);
        if (current && (!best || current.score > best.score)) best = current;
        if (best && best.score >= 180 && /\b\d+\.\s*\d{1,2}:\d{2}/i.test(best.compact)) break;
      }

      if (best && best.score >= 100) {
        const rowHtml = attachDetail(entity, best.text);
        return rememberRecordedDetail({
          kind,
          ...meta,
          targetId,
          token,
          detailText: best.text,
          candidateScore: best.score,
          candidateSource: best.source || best.reason || 'unknown',
          rowHtml,
          entityHtml: entity.outerHTML,
          candidateHtml: best.html || '',
          capturedAt: new Date().toISOString(),
        });
      }

      return rememberRecordedDetail({
        kind: `${kind}-miss`,
        ...meta,
        targetId,
        token,
        candidates: candidateElements('miss').slice(0, 8).map(item => ({
          score: scoreCandidate(item, meta),
          className: item.className,
          text: item.compact.slice(0, 500),
        })),
        capturedAt: new Date().toISOString(),
      });
    }

    document.addEventListener('click', event => {
      const entity = entityFromTarget(event.target);
      if (!entity) return;
      window.__adpAutoLastClickedEntity = entity;
      window.__adpAutoLastClickToken += 1;
      const token = window.__adpAutoLastClickToken;
      entity.setAttribute('data-adp-auto-click-token', String(token));
      setTimeout(() => recordOverlaySnapshot('after-click-0'), 0);
      setTimeout(() => recordOverlaySnapshot('after-click-20'), 20);
      setTimeout(() => recordOverlaySnapshot('after-click-60'), 60);
      setTimeout(() => captureEntity(entity, 'shift-detail-record', { token }), 0);
    }, true);

    window.__adpAutoCaptureShiftDetailTarget = async function captureShiftDetailTarget(targetId, options = {}) {
      const existingBefore = storedRecordForTarget(targetId);
      if (existingBefore) return existingBefore;
      const entity = document.querySelector(`[data-adp-auto-shift-target="${CSS.escape(String(targetId || ''))}"]`);
      if (!entity) return { kind: 'shift-detail-miss', message: 'target shift entity not found', targetId };
      window.__adpAutoLastClickedEntity = entity;
      let token = Number(entity.getAttribute('data-adp-auto-click-token') || '') || window.__adpAutoLastClickToken || 0;
      if (!token) {
        window.__adpAutoLastClickToken += 1;
        token = window.__adpAutoLastClickToken;
        entity.setAttribute('data-adp-auto-click-token', String(token));
      }
      recordOverlaySnapshot('real-click-start');
      await sleep(Math.min(180, Math.max(50, Number(options.delayMs || window.__adpAutoDetailDelayMs || 800) / 5)));
      const existingAfterClick = storedRecordForTarget(targetId);
      if (existingAfterClick) return existingAfterClick;
      const directRecord = await captureEntity(entity, 'shift-detail-record', { token });
      if (directRecord?.kind === 'shift-detail-record') return directRecord;
      return storedRecordForTarget(targetId) || directRecord;
    };
  }, { delayMs: Number(env('ADP_SHIFT_DETAIL_DELAY_MS', '900')) });
}

async function scrollToBaselineEmployeeRow(page, baselineRow, options = {}) {
  const delayMs = Number(env('ADP_SCROLL_DELAY_MS', '1000'));
  const maxPasses = Number(env('ADP_SHIFT_DETAIL_FIND_ROW_MAX_PASSES', '220'));
  const rowLabel = `${baselineRow.name} | ${baselineRow.primaryJob || ''}`;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await page.evaluate(({ row, pass }) => {
      function cleanText(value) {
        return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      }
      function rowName(el) {
        return cleanText(el.querySelector('[col-id="name"] .location-schedule-employee-cell__name')?.textContent || el.querySelector('[col-id="name"]')?.textContent || '');
      }
      function rowPrimaryJob(el) {
        return cleanText(
          el.querySelector('[col-id="primaryJob"] primary-job-cell span')?.textContent
          || el.querySelector('[col-id="primaryJob"] .ag-cell-text > span')?.textContent
          || el.querySelector('[col-id="primaryJob"] .ag-cell-text')?.childNodes?.[0]?.textContent
          || el.querySelector('[col-id="primaryJob"]')?.textContent
          || ''
        );
      }
      function rowSortIndex(el) {
        const raw = el.getAttribute('row-index') || '';
        if (raw === 't-0') return -1;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : 999999;
      }
      function scoreScroller(el) {
        if (!el) return -1;
        const rect = el.getBoundingClientRect();
        const overflow = Math.max(0, el.scrollHeight - el.clientHeight);
        if (overflow < 20 || rect.width < 300 || rect.height < 150) return -1;
        const className = String(el.className || '');
        let score = overflow;
        if (/ag-body-vertical-scroll-viewport/.test(className)) score += 100000;
        if (/ag-body-viewport/.test(className)) score += 80000;
        if (/ag-center-cols-viewport/.test(className)) score += 60000;
        return score;
      }
      function gridScroller() {
        const candidates = [
          ...document.querySelectorAll('.ag-body-vertical-scroll-viewport, .ag-body-viewport, .ag-center-cols-viewport'),
          ...Array.from(document.querySelectorAll('*')).filter(el => {
            const style = window.getComputedStyle(el);
            return /(auto|scroll)/.test(style.overflowY || '') && el.scrollHeight > el.clientHeight + 80;
          })
        ];
        const seen = new Set();
        return candidates
          .filter(el => {
            if (!el || seen.has(el)) return false;
            seen.add(el);
            return scoreScroller(el) > 0;
          })
          .sort((a, b) => scoreScroller(b) - scoreScroller(a))[0] || null;
      }
      const rows = Array.from(document.querySelectorAll('.ag-floating-top-container > div[role="row"], .ag-center-cols-container > div[role="row"]'));
      for (const el of rows) {
        const name = rowName(el);
        const primaryJob = rowPrimaryJob(el);
        if (name === row.name && (!row.primaryJob || primaryJob === row.primaryJob)) {
          const targetId = `adp-auto-row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          el.setAttribute('data-adp-auto-row-target', targetId);
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return { found: true, targetId, visibleNames: rows.map(rowName).filter(Boolean), scrollTop: gridScroller()?.scrollTop || 0 };
        }
      }

      const scroller = gridScroller();
      const visible = rows.map(el => ({ name: rowName(el), primaryJob: rowPrimaryJob(el), sortIndex: rowSortIndex(el) })).filter(item => item.name);
      const indexes = visible.map(item => item.sortIndex).filter(index => index >= 0 && index < 999999);
      const minIndex = indexes.length ? Math.min(...indexes) : null;
      const maxIndex = indexes.length ? Math.max(...indexes) : null;
      if (!scroller) return { found: false, noScroller: true, visibleNames: visible.map(item => item.name) };

      if (pass === 0 && Number.isFinite(row.sortIndex) && row.sortIndex >= 0 && row.sortIndex < 999999) {
        const sample = rows.find(el => rowSortIndex(el) >= 0);
        const rowHeight = sample?.getBoundingClientRect?.().height || 40;
        scroller.scrollTop = Math.max(0, (row.sortIndex - 3) * rowHeight);
      } else if (minIndex !== null && Number.isFinite(row.sortIndex) && row.sortIndex < minIndex) {
        scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(80, scroller.clientHeight * 0.55));
      } else {
        scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + Math.max(80, scroller.clientHeight * 0.55));
      }
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      return {
        found: false,
        visibleNames: visible.map(item => item.name),
        minIndex,
        maxIndex,
        scrollTop: scroller.scrollTop,
        maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      };
    }, { row: baselineRow, pass });

    if (result.found) return result;
    const atBottom = result.maxScrollTop !== undefined && Math.abs(result.maxScrollTop - result.scrollTop) < 3;
    if (atBottom && pass > 5 && !options.allowBottomRetry) break;
    await page.waitForTimeout(delayMs);
  }

  throw new Error(`Could not find baseline employee row during shift-detail pass: ${rowLabel}`);
}

async function captureVisibleBaselineRowDetails(page, baselineRow) {
  const delayMs = Number(env('ADP_SHIFT_DETAIL_DELAY_MS', '900'));
  const clickDelayMs = Number(env('ADP_SHIFT_DETAIL_CLICK_DELAY_MS', '150'));
  const rowTarget = await scrollToBaselineEmployeeRow(page, baselineRow, { allowBottomRetry: true });

  const targetsResult = await page.evaluate(({ rowTargetId }) => {
    function compactText(value) {
      return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function getDayCell(entity) {
      return entity?.closest?.('[col-id^="day-"]') || null;
    }
    function entityOrder(entity) {
      const dayCell = getDayCell(entity);
      const dayRaw = dayCell?.getAttribute('col-id') || '';
      const dayMatch = dayRaw.match(/day-(\d+)/);
      const day = dayMatch ? Number(dayMatch[1]) : 99;
      const rect = entity.getBoundingClientRect();
      return { day, top: rect.top, left: rect.left };
    }
    function targetPayload(entity, index) {
      const rect = entity.getBoundingClientRect();
      const targetId = `adp-auto-shift-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
      entity.setAttribute('data-adp-auto-shift-target', targetId);
      const title = compactText(entity.querySelector('.location-schedule-cell__title')?.textContent || entity.textContent || '');
      const automationId = entity.getAttribute('automation-id') || '';
      return {
        targetId,
        shiftTitle: title,
        shiftId: automationId.replace('location_schedule_cell_shift_', '') || automationId,
        dayCol: getDayCell(entity)?.getAttribute('col-id') || '',
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      };
    }

    const row = document.querySelector(`[data-adp-auto-row-target="${CSS.escape(rowTargetId)}"]`);
    if (!row) return { ok: false, error: 'row target not found' };
    const entities = Array.from(row.querySelectorAll('.location-schedule-cell__entity, [automation-id^="location_schedule_cell_shift_"]'))
      .filter(isVisible)
      .sort((a, b) => {
        const aa = entityOrder(a);
        const bb = entityOrder(b);
        return aa.day - bb.day || aa.top - bb.top || aa.left - bb.left;
      });
    return {
      ok: true,
      targetRowId: row.getAttribute('row-id') || '',
      targetRowIndex: row.getAttribute('row-index') || '',
      targets: entities.map(targetPayload),
      rowHtml: row.outerHTML,
    };
  }, { rowTargetId: rowTarget.targetId });

  if (!targetsResult.ok) {
    return { ok: false, employeeName: baselineRow.name, primaryJob: baselineRow.primaryJob, error: targetsResult.error, records: [], misses: [], rowHtml: baselineRow.html };
  }

  const records = [];
  const misses = [];

  for (const [index, target] of targetsResult.targets.entries()) {
    const current = await page.evaluate(targetId => {
      const entity = document.querySelector(`[data-adp-auto-shift-target="${CSS.escape(targetId)}"]`);
      if (!entity) return null;
      entity.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = entity.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }, target.targetId);

    if (!current || current.width <= 0 || current.height <= 0) {
      misses.push({ kind: 'shift-detail-miss', ...target, message: 'target shift cell was not visible before real click', capturedAt: new Date().toISOString() });
      continue;
    }

    const x = Math.max(1, Math.min(current.right - 2, current.left + Math.min(40, Math.max(8, current.width / 2))));
    const y = Math.max(1, Math.min(current.bottom - 2, current.top + Math.min(18, Math.max(8, current.height / 2))));

    await page.evaluate(targetId => {
      const entity = document.querySelector(`[data-adp-auto-shift-target="${CSS.escape(targetId)}"]`);
      if (!entity) return;
      window.__adpAutoLastClickedEntity = entity;
      window.__adpAutoLastClickToken = (window.__adpAutoLastClickToken || 0) + 1;
      entity.setAttribute('data-adp-auto-click-token', String(window.__adpAutoLastClickToken));
      window.__adpAutoRecordedDetails = (window.__adpAutoRecordedDetails || []).filter(item => item.targetId !== targetId);
    }, target.targetId);

    await page.mouse.move(x, y);
    await page.waitForTimeout(40);
    await page.mouse.down();
    await page.waitForTimeout(20);
    await page.mouse.up();
    await page.waitForTimeout(90);

    let record = await page.evaluate(async ({ targetId, delayMs }) => {
      if (!window.__adpAutoCaptureShiftDetailTarget) return { kind: 'shift-detail-miss', message: 'capture helper missing', targetId };
      return window.__adpAutoCaptureShiftDetailTarget(targetId, { delayMs });
    }, { targetId: target.targetId, delayMs });

    if (record?.kind !== 'shift-detail-record') {
      // fallback to the manual repo's in-page click path
      // useful for the pinned current-user row when the outer mouse click focuses the grid but loses the transient popover
      record = await page.evaluate(async ({ targetId, delayMs }) => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const entity = document.querySelector(`[data-adp-auto-shift-target="${CSS.escape(targetId)}"]`);
        if (!entity || !window.__adpAutoCaptureShiftDetailTarget) {
          return { kind: 'shift-detail-miss', message: 'fallback target/helper missing', targetId };
        }
        window.__adpAutoLastClickedEntity = entity;
        window.__adpAutoLastClickToken = (window.__adpAutoLastClickToken || 0) + 1;
        entity.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        entity.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        entity.click();
        await sleep(60);
        return window.__adpAutoCaptureShiftDetailTarget(targetId, { delayMs });
      }, { targetId: target.targetId, delayMs });
    }

    if (record?.kind === 'shift-detail-record') records.push(record);
    else misses.push(record || { kind: 'shift-detail-miss', ...target, message: 'no capture result returned', capturedAt: new Date().toISOString() });

    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(clickDelayMs);
    if ((index + 1) % 5 === 0) console.log(`[shift-detail] ${baselineRow.name}: ${index + 1}/${targetsResult.targets.length} clicked`);
  }

  const rowHtml = await page.evaluate(rowTargetId => {
    const row = document.querySelector(`[data-adp-auto-row-target="${CSS.escape(rowTargetId)}"]`);
    return row ? row.outerHTML : '';
  }, rowTarget.targetId);

  return {
    ok: misses.length === 0 && records.length === targetsResult.targets.length,
    employeeName: baselineRow.name,
    primaryJob: baselineRow.primaryJob,
    expectedShiftCount: baselineRow.shiftCount,
    targetShiftCount: targetsResult.targets.length,
    detailCount: records.length,
    missCount: misses.length,
    records,
    misses,
    rowHtml: rowHtml || targetsResult.rowHtml || baselineRow.html,
  };
}

async function captureShiftBreakdownsFromBaseline(page, baselineCapture) {
  await installAutoShiftDetailRuntime(page);
  await resetScheduleGridToTop(page);

  const rows = (baselineCapture?.rows || []).slice().sort((a, b) => {
    if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const allRowsWithShifts = rows.filter(row => Number(row.shiftCount || 0) > 0);
  const skippedRows = [];
  const rowsWithShifts = allRowsWithShifts.filter(row => {
    const name = String(row.name || '').trim();
    const isPinnedMySchedule = name === 'My Schedule' || Number(row.sortIndex) < 0;
    if (isPinnedMySchedule) {
      skippedRows.push({ name: row.name, primaryJob: row.primaryJob, shiftCount: row.shiftCount, reason: 'pinned My Schedule row' });
      return false;
    }
    return true;
  });
  const rowRetries = Number(env('ADP_SHIFT_DETAIL_ROW_RETRIES', '2'));
  const timeoutMs = Number(env('ADP_SHIFT_DETAIL_CAPTURE_TIMEOUT_MS', '3600000'));
  const started = Date.now();
  const rowMap = new Map(rows.map(row => [row.key, row.html]));
  const records = [];
  const misses = [];
  let processedRows = 0;

  if (skippedRows.length) {
    console.log(`Skipping ${skippedRows.length} pinned non-employee row(s) during strict shift-detail pass: ${skippedRows.map(row => row.name).join(', ')}`);
  }
  console.log(`Shift breakdown capture pass: ${rowsWithShifts.length} employee rows with shifts from the baseline capture.`);

  for (const row of rowsWithShifts) {
    if (row.sortIndex === -1 || String(row.name || '').trim().toLowerCase() === 'my schedule') {
      // the current-user row is pinned separately from the virtualized body
      // reset to the top before clicking it to match the manual capture flow
      await resetScheduleGridToTop(page);
    }

    if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
      throw new Error(`Shift breakdown capture timed out after ${timeoutMs}ms before completing ${row.name}. Processed ${processedRows}/${rowsWithShifts.length} rows.`);
    }

    let result = null;
    for (let attempt = 1; attempt <= rowRetries + 1; attempt += 1) {
      result = await captureVisibleBaselineRowDetails(page, row);
      if (result.ok && result.detailCount === row.shiftCount) break;
      console.warn(`[shift-detail] retry ${attempt}/${rowRetries + 1} for ${row.name}: recorded ${result?.detailCount || 0}/${row.shiftCount}, misses ${result?.missCount || 0}`);
      await page.waitForTimeout(Number(env('ADP_SHIFT_DETAIL_RETRY_DELAY_MS', '900')));
    }

    if (result?.rowHtml) rowMap.set(row.key, result.rowHtml);
    records.push(...(result?.records || []));
    misses.push(...(result?.misses || []));
    processedRows += 1;

    if (!result?.ok || result.detailCount !== row.shiftCount) {
      const message = `[shift-detail] incomplete ${row.name} | ${row.primaryJob || ''}: recorded ${result?.detailCount || 0}/${row.shiftCount}`;
      if (boolEnv('ADP_REQUIRE_FULL_SHIFT_BREAKDOWNS', true)) {
        throw new Error(`${message}. Refusing to advance because full shift breakdown coverage is required.`);
      }
      console.warn(message);
    } else {
      console.log(`[shift-detail] completed ${processedRows}/${rowsWithShifts.length}: ${row.name} (${result.detailCount}/${row.shiftCount})`);
    }
  }

  const enrichedRows = rows.map(row => ({ ...row, html: rowMap.get(row.key) || row.html }));
  return {
    ...baselineCapture,
    rows: enrichedRows,
    rowCount: enrichedRows.length,
    shiftDetailCapture: {
      processed_employee_rows: processedRows,
      expected_employee_rows_with_shifts: rowsWithShifts.length,
      captured_shift_detail_count: records.length,
      shift_detail_miss_count: misses.length,
      complete: processedRows === rowsWithShifts.length && misses.length === 0,
      skipped_non_employee_rows: skippedRows,
      records_preview: records.slice(0, 12).map(record => ({ employeeName: record.employeeName, shiftTitle: record.shiftTitle })),
      misses_preview: misses.slice(0, 12).map(miss => ({ employeeName: miss.employeeName, shiftTitle: miss.shiftTitle, message: miss.message })),
    }
  };
}

function injectCapturedVirtualRows(html, virtualGridCapture) {
  if (!virtualGridCapture || !Array.isArray(virtualGridCapture.rows) || virtualGridCapture.rows.length === 0) {
    return html;
  }

  const rowHtml = virtualGridCapture.rows.map(row => row.html).join('\n');
  const block = `
<div id="adp-schedule-captured-virtual-rows" class="ag-center-cols-container" data-captured-row-count="${virtualGridCapture.rowCount}">
${rowHtml}
</div>
`;

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  return `${html}${block}`;
}

async function saveCapture(page, outputDir, virtualGridCapture = null) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = timestamp();
  const htmlPath = path.join(outputDir, `schedule_${stamp}.html`);
  const latestPath = path.join(outputDir, 'latest_schedule.html');
  const textPath = path.join(outputDir, `schedule_${stamp}.visible_text.txt`);
  const latestTextPath = path.join(outputDir, 'latest_visible_text.txt');
  const screenshotPath = path.join(outputDir, `schedule_${stamp}.png`);
  const metadataPath = path.join(outputDir, `schedule_${stamp}.metadata.json`);

  const rawHtml = await page.content();
  const html = injectCapturedVirtualRows(rawHtml, virtualGridCapture);
  const visibleText = await getVisibleText(page);
  await fs.writeFile(htmlPath, html, 'utf8');
  await fs.writeFile(latestPath, html, 'utf8');
  await fs.writeFile(textPath, visibleText, 'utf8');
  await fs.writeFile(latestTextPath, visibleText, 'utf8');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(error => console.warn(`Screenshot failed: ${error.message}`));

  const metadata = {
    captured_at: new Date().toISOString(),
    url: page.url(),
    title: await page.title().catch(() => ''),
    html_file: htmlPath,
    latest_html_file: latestPath,
    visible_text_file: textPath,
    screenshot_file: await fileExists(screenshotPath) ? screenshotPath : null,
    virtual_grid_capture: virtualGridCapture ? {
      expected_employee_count: virtualGridCapture.expectedEmployeeCount,
      captured_row_count: virtualGridCapture.rowCount,
      complete: Boolean(virtualGridCapture.complete),
      max_sort_index: virtualGridCapture.maxSortIndex ?? null,
      used_scroller: virtualGridCapture.usedScroller,
      captured_names_preview: virtualGridCapture.rows.slice(0, 8).map(row => row.name),
      captured_names_tail: virtualGridCapture.rows.slice(-8).map(row => row.name),
      shift_detail_capture: virtualGridCapture.shiftDetailCapture || null,
    } : null,
    captured_shift_detail_count: virtualGridCapture?.shiftDetailCapture?.captured_shift_detail_count || 0,
    shift_detail_miss_count: virtualGridCapture?.shiftDetailCapture?.shift_detail_miss_count || 0
  };
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return { htmlPath, latestPath, textPath, screenshotPath, metadataPath };
}

function runParser(htmlPaths, outDir) {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const inputFiles = Array.isArray(htmlPaths) ? htmlPaths : [htmlPaths];
    const args = [
      'team_schedule_parser.py',
      ...inputFiles,
      '--out-dir', outDir,
      '--timezone', env('CALENDAR_TIMEZONE', 'America/Vancouver'),
      '--calendar-location', env('CALENDAR_LOCATION', ''),
      '--alarms', env('CALENDAR_ALARMS', '1440,180,60'),
      '--refresh-minutes', env('CALENDAR_REFRESH_MINUTES', '60')
    ];
    console.log(`Running parser: ${python} ${args.map(a => JSON.stringify(a)).join(' ')}`);
    const child = spawn(python, args, { stdio: 'inherit', cwd: __dirname });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Parser exited with code ${code}`));
    });
  });
}

async function main() {
  const startUrl = env('ADP_URL', DEFAULT_START_URL);
  const outputDir = path.resolve(env('OUTPUT_DIR', 'captures'));
  const parsedOutDir = path.resolve(env('PARSED_OUT_DIR', 'parsed_schedule'));
  const profileDir = path.resolve(env('ADP_PROFILE_DIR', '.auth/adp-browser-profile'));
  const headless = boolEnv('ADP_HEADLESS', false);
  const incognito = boolEnv('ADP_INCOGNITO', true);

  console.log('\nADP schedule auto capture');
  console.log('========================');
  console.log(`Start URL:     ${startUrl}`);
  console.log(`Headless:      ${headless}`);
  console.log(`Incognito:     ${incognito}`);
  if (!incognito) console.log(`Profile dir:   ${profileDir}`);
  console.log(`Capture dir:   ${outputDir}`);
  console.log(`Parsed out dir:${parsedOutDir}`);
  console.log('\nKeep .env, .auth, captures, and parsed_schedule private. They can contain credentials/cookies or employee schedule data.\n');

  const windowWidth = numberEnv('ADP_WINDOW_WIDTH', 1600);
  const windowHeight = numberEnv('ADP_WINDOW_HEIGHT', 1000);
  const browserLocale = env('ADP_LOCALE', 'en-CA');
  const browserTimezone = env('ADP_TIMEZONE_ID', env('CALENDAR_TIMEZONE', 'America/Vancouver'));
  const userAgent = envRaw('ADP_USER_AGENT', '');

  const launchOptions = {
    headless,
    args: headless ? [] : [`--window-size=${windowWidth},${windowHeight}`]
  };

  const contextOptions = {
    viewport: headless ? { width: windowWidth, height: windowHeight } : null,
    acceptDownloads: true,
    locale: browserLocale,
    timezoneId: browserTimezone
  };

  if (userAgent) {
    contextOptions.userAgent = userAgent;
  }

  console.log(`Browser locale: ${browserLocale}`);
  console.log(`Browser timezone: ${browserTimezone}`);
  console.log(`Browser window/viewport target: ${windowWidth}x${windowHeight}`);
  if (userAgent) console.log('Browser user agent override: enabled');

  let browser = null;
  let context = null;
  let page = null;
  let traceActive = false;

  if (incognito) {
    console.log('Launching Chromium with a temporary incognito browser context. No cookies/session will be saved after this run.');
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
  } else {
    console.log('Launching Chromium with a persistent local browser profile. Cookies/session may be reused between runs.');
    await fs.mkdir(profileDir, { recursive: true });
    context = await chromium.launchPersistentContext(profileDir, {
      ...launchOptions,
      ...contextOptions
    });
    page = context.pages()[0] || await context.newPage();
  }

  const traceEnabled = boolEnv('ADP_TRACE', debugEnabled());
  if (traceEnabled) {
    await fs.mkdir(outputDir, { recursive: true });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceActive = true;
    console.log('Playwright tracing is enabled. A trace ZIP will be saved under captures/.');
  }

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await attemptLogin(page);
    await waitForAuthToSettle(page);
    page = await navigateToWorkFeaturesPage(page, context);
    page = await navigateToTeamSchedule(page, context);

    const weeksToCaptureRaw = Number.parseInt(env('ADP_WEEKS_TO_CAPTURE', '4'), 10);
    const weeksToCapture = Number.isFinite(weeksToCaptureRaw) && weeksToCaptureRaw > 0 ? weeksToCaptureRaw : 4;
    const startWeekOffset = nonNegativeNumberEnv('ADP_START_WEEK_OFFSET', 0);
    const savedHtmlPaths = [];
    let latestSaved = null;

    if (startWeekOffset > 0) {
      console.log(`Advancing ${startWeekOffset} week(s) before starting capture.`);
      for (let offset = 0; offset < startWeekOffset; offset += 1) {
        await waitForScheduleGridReady(page);
        await clickNextScheduleWeek(page);
      }
    }

    for (let weekIndex = 0; weekIndex < weeksToCapture; weekIndex += 1) {
      await waitForScheduleGridReady(page);
      await ensureAllLocationsAndJobsSelected(page);
      await waitForScheduleGridReady(page);

      const readiness = await validateScheduleCaptureReady(page);
      const currentRange = readiness.dateRange;
      console.log(`\nCapturing week ${weekIndex + 1}/${weeksToCapture}: ${currentRange}`);
      console.log(`Validated schedule page: ${readiness.employeeCount} employees, ${readiness.jobsLabel || 'jobs selected'}.`);

      let virtualGridCapture = await collectVirtualGridRows(page);
      if (virtualGridCapture.expectedEmployeeCount < Number(env('ADP_MIN_EXPECTED_EMPLOYEES', '20'))) {
        throw new Error(`Baseline capture returned an implausible employee count (${virtualGridCapture.expectedEmployeeCount}) for ${currentRange}. This attempt will be retried from a fresh browser session.`);
      }
      if (boolEnv('ADP_REQUIRE_FULL_EMPLOYEE_CAPTURE', true) && !virtualGridCapture.complete) {
        throw new Error(`Baseline capture did not include every employee for ${currentRange || `week ${weekIndex + 1}`}: captured ${virtualGridCapture.rowCount}/${virtualGridCapture.expectedEmployeeCount}; last visible ${virtualGridCapture.scrollStats?.lastVisibleName || 'unknown'}. Refusing to publish incomplete calendars.`);
      }

      if (shiftDetailEnabled()) {
        console.log('Starting second pass for shift breakdowns from the complete baseline employee list...');
        await resetScheduleGridToTop(page);
        virtualGridCapture = await captureShiftBreakdownsFromBaseline(page, virtualGridCapture);
      }

      latestSaved = await saveCapture(page, outputDir, virtualGridCapture);
      savedHtmlPaths.push(latestSaved.htmlPath);

      if (weekIndex < weeksToCapture - 1) {
        await clickNextScheduleWeek(page);
      }
    }

    if (boolEnv('ADP_SKIP_PARSE', false)) {
      console.log('Skipping parser because ADP_SKIP_PARSE=true. Captured HTML files are ready for a later merge parse step.');
    } else {
      await runParser(savedHtmlPaths, parsedOutDir);
    }

    if (traceActive) {
      await stopTraceIfActive(context, outputDir, 'success');
      traceActive = false;
    }

    console.log('\nDone. Key files:');
    console.log(`- Captured HTML files:`);
    for (const htmlPath of savedHtmlPaths) console.log(`  - ${htmlPath}`);
    if (latestSaved) console.log(`- Latest captured HTML alias: ${latestSaved.latestPath}`);
    console.log(`- Visible text:  ${path.join(outputDir, 'latest_visible_text.txt')}`);
    console.log(`- Parsed output: ${parsedOutDir}`);
  } catch (error) {
    console.warn(`Saving debug artifacts because automation failed: ${error.message || error}`);
    await saveDebugSnapshot(page, outputDir, 'automation_failure', {
      error_message: error.message || String(error),
      error_stack: error.stack || null,
    }).catch(snapshotError => console.warn(`Could not save debug snapshot: ${snapshotError.message}`));

    if (traceActive) {
      await stopTraceIfActive(context, outputDir, 'failure').catch(traceError => console.warn(`Could not save Playwright trace: ${traceError.message}`));
      traceActive = false;
    }

    throw error;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main().catch(error => {
  console.error('\nAutomation failed:');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});