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
  console.log('The below should be the values that are inputted');
  console.log(username);
  console.log(password);
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

async function navigateToTeamSchedule(page, context) {
  page = await recoverOpenPage(context, page, 'ADP Team Schedule navigation');

  const directUrl = env('TEAM_SCHEDULE_URL');
  if (directUrl) {
    console.log(`Going directly to TEAM_SCHEDULE_URL: ${directUrl}`);
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    page = await recoverOpenPage(context, page, 'ADP Team Schedule navigation');
    return page;
  }

  const text = env('TEAM_SCHEDULE_TEXT', 'Team Schedule');
  console.log(`Looking for Team Schedule tile/button: ${text}`);

  const popupPromise = page.waitForEvent('popup', { timeout: 7000 }).catch(() => null);
  const clicked = await clickButtonLike(page, [new RegExp(`Go to\\s+${text}`, 'i'), new RegExp(text, 'i')], 1500);
  if (!clicked) {
    const body = await getVisibleText(page);
    throw new Error(`Could not find/click Team Schedule. Current page text starts with:\n${body.slice(0, 800)}`);
  }

  const popup = await popupPromise;
  if (popup) {
    console.log('Team Schedule opened a new tab/window. Switching to it.');
    page = popup;
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 90_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  page = await recoverOpenPage(context, page, 'ADP Team Schedule navigation');
  await page.waitForTimeout(5000);
  return page;
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
      return String(value || '').replace(/\s+/g, ' ').trim();
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

    function rowSortIndex(row) {
      const raw = row.getAttribute('row-index') || '';
      if (raw === 't-0') return -1;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : 999999;
    }

    function collectVisibleRows(reason) {
      const selector = [
        '.ag-floating-top-container > div[role="row"]',
        '.ag-center-cols-container > div[role="row"]'
      ].join(', ');

      for (const row of document.querySelectorAll(selector)) {
        const name = rowName(row);
        if (!name) continue;

        const rowId = row.getAttribute('row-id') || '';
        const rowIndex = row.getAttribute('row-index') || '';
        const primaryJob = cleanText(row.querySelector('[col-id="primaryJob"]')?.textContent || '');

        const key = rowId ? `id:${rowId}` : `pinned:${name}:${primaryJob}`;
        rows.set(key, {
          key,
          name,
          rowId,
          rowIndex,
          sortIndex: rowSortIndex(row),
          reason,
          html: row.outerHTML,
        });
      }
    }

    function scrollableElements() {
      const preferredSelectors = [
        '.ag-body-viewport',
        '.ag-center-cols-viewport',
        '.ag-body-vertical-scroll-viewport'
      ];

      const preferred = preferredSelectors
        .flatMap(selector => Array.from(document.querySelectorAll(selector)))
        .filter(Boolean);

      const fallback = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const style = window.getComputedStyle(el);
          const canScrollY = /(auto|scroll)/.test(style.overflowY || '');
          return canScrollY && el.scrollHeight > el.clientHeight + 80;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

      const seen = new Set();
      return [...preferred, ...fallback].filter(el => {
        if (!el || seen.has(el)) return false;
        seen.add(el);
        return el.scrollHeight > el.clientHeight + 20;
      });
    }

    const expectedEmployeeCount = getExpectedEmployeeCount();
    window.scrollTo(0, 0);
    await sleep(delayMs);
    collectVisibleRows('initial');

    const scrollers = scrollableElements();
    const scroller = scrollers[0];

    if (!scroller) {
      return {
        expectedEmployeeCount,
        rowCount: rows.size,
        rows: Array.from(rows.values()),
        usedScroller: null,
      };
    }

    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Math.max(120, Math.floor(scroller.clientHeight * 0.45));

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(delayMs * 2);
    collectVisibleRows('top');

    for (let y = 0; y <= max + step; y += step) {
      scroller.scrollTop = Math.min(y, max);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(delayMs);
      collectVisibleRows(`scroll:${Math.min(y, max)}`);

      if (expectedEmployeeCount && rows.size >= expectedEmployeeCount + 1) break;
    }

    scroller.scrollTop = max;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(delayMs);
    collectVisibleRows('bottom');

    const sortedRows = Array.from(rows.values()).sort((a, b) => {
      if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
      return a.name.localeCompare(b.name);
    });

    return {
      expectedEmployeeCount,
      rowCount: sortedRows.length,
      rows: sortedRows,
      usedScroller: {
        className: scroller.className || '',
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScrollTop: max,
        step,
      },
    };
  }, { delayMs: Number(env('ADP_SCROLL_DELAY_MS', '250')) });

  console.log(`Collected ${result.rowCount} rendered schedule rows${result.expectedEmployeeCount ? `; header expects ${result.expectedEmployeeCount}` : ''}.`);
  if (result.expectedEmployeeCount && result.rowCount < result.expectedEmployeeCount) {
    console.warn(`WARNING: collected ${result.rowCount} rows, but the header expects ${result.expectedEmployeeCount}. Try increasing ADP_SCROLL_DELAY_MS.`);
  }

  await page.waitForTimeout(1000);
  return result;
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
      used_scroller: virtualGridCapture.usedScroller,
      captured_names_preview: virtualGridCapture.rows.slice(0, 8).map(row => row.name),
    } : null
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
    const savedHtmlPaths = [];
    let latestSaved = null;

    for (let weekIndex = 0; weekIndex < weeksToCapture; weekIndex += 1) {
      await waitForScheduleGridReady(page);
      await ensureAllLocationsAndJobsSelected(page);
      await waitForScheduleGridReady(page);

      const currentRange = await readScheduleDateRange(page);
      console.log(`\nCapturing week ${weekIndex + 1}/${weeksToCapture}${currentRange ? `: ${currentRange}` : ''}`);

      const virtualGridCapture = await collectVirtualGridRows(page);
      latestSaved = await saveCapture(page, outputDir, virtualGridCapture);
      savedHtmlPaths.push(latestSaved.htmlPath);

      if (weekIndex < weeksToCapture - 1) {
        await clickNextScheduleWeek(page);
      }
    }

    await runParser(savedHtmlPaths, parsedOutDir);

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