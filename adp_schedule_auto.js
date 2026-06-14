#!/usr/bin/env node
/*
  ADP/UKG automatic schedule capture + parser runner.

  This script:
  1) Opens ADP/MyADP using Playwright.
  2) Attempts a normal username/password login from .env, if a login form appears.
  3) Waits for you to finish MFA/security checkpoint manually when required.
  4) Navigates to My Work Features, then opens Team Schedule.
  5) Scrolls the virtualized grid to load as many rows as possible.
  6) Saves the schedule HTML.
  7) Runs team_schedule_parser.py to create CSV/JSON and employee .ics files.

  It does not bypass MFA and it does not ask you to paste credentials into chat.
*/

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const dotenv = require('dotenv');

loadEnvFiles();

const DEFAULT_START_URL = 'https://my.adp.com/#/time';
const DEFAULT_WORK_FEATURES_URL = 'https://my.adp.com/#/time/myworkfeatures';

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


function env(name, fallback = '') {
  return process.env[name] && process.env[name].trim() !== '' ? process.env[name].trim() : fallback;
}

function boolEnv(name, fallback = false) {
  const value = env(name, String(fallback)).toLowerCase();
  return ['1', 'true', 'yes', 'y'].includes(value);
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

      // Some ADP/SDF fields are custom elements that contain a real input inside
      // their light DOM. Shadow DOM inputs are normally reachable through
      // Playwright's CSS selectors, but this helps with custom wrappers.
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
  // Prefer actual input selectors first. getByLabel(/user id/i) can match
  // ADP's "Remember user ID" checkbox, which is not fillable.
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

  // Password widgets sometimes mask or intentionally hide the readable value
  // after a successful fill. Seeing any value is enough to continue.
  if (/password/i.test(label) && current.length > 0) return true;

  // ADP may normalize username casing or formatting. If the field is non-empty
  // after fill(), do not destroy it with a retry just because the exact string
  // comparison failed.
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

  // Some ADP widgets re-render immediately after fill(), especially in
  // incognito. If the original locator disappeared, assume the fill caused the
  // page to advance and let the caller continue to the next step. This avoids
  // timing out while trying to type into a stale username locator.
  if (!(await locatorIsFillable(locator, 500))) {
    console.log(`${label} field changed or disappeared after fill(); continuing to the next login step.`);
    return true;
  }

  // Some login widgets ignore a fast fill until the field is focused/keyed.
  // Retry using page-level keyboard events instead of locator.pressSequentially(),
  // because ADP can detach/recreate the element during typing.
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
          // Text may be inside a non-clickable child. Try a nearby button/link.
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
  const username = env('ADP_USERNAME');
  const password = env('ADP_PASSWORD');
  if (!username || !password) {
    console.log('No ADP_USERNAME/ADP_PASSWORD in .env. Using existing browser session or manual login.');
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

  // ADP often shows username and password on the same screen. Fill password
  // before clicking Sign in. If the screen is a two-step login, click Next and
  // then wait for the password field.
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

async function waitUntilTimeLandingOrLoggedIn(page) {
  const headless = boolEnv('ADP_HEADLESS', false);
  const timeoutMs = 90_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const text = await getVisibleText(page);
    if (/Team Schedule/i.test(text) || /My Calendar/i.test(text) || /My Timecard/i.test(text) || /Time - MyADP/i.test(await page.title().catch(() => ''))) {
      return;
    }
    if (/security checkpoint|verification|verify|multi-factor|multifactor|authenticator|code/i.test(text)) {
      if (headless) throw new Error('ADP is asking for MFA/security checkpoint. Run once with ADP_HEADLESS=false and complete it manually.');
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


async function isMfaOrSecurityCheckpointVisible(page) {
  const text = await getVisibleText(page);
  return /security checkpoint|verification|verify|multi-factor|multifactor|authenticator|code/i.test(text);
}

async function waitForAuthToSettle(page) {
  const headless = boolEnv('ADP_HEADLESS', false);
  const timeoutMs = Number(env('ADP_POST_LOGIN_TIMEOUT_MS', '90000'));
  const start = Date.now();

  console.log(`Waiting up to ${timeoutMs}ms for ADP login/MFA to settle...`);

  while (Date.now() - start < timeoutMs) {
    if (await isMfaOrSecurityCheckpointVisible(page)) {
      if (headless) throw new Error('ADP is asking for MFA/security checkpoint. Run once with ADP_HEADLESS=false and complete it manually.');
      console.log('\nADP security checkpoint/MFA detected. Complete it in the browser window.');
      await ask('After ADP finishes logging in, press Enter here... ');
      return;
    }

    // If the regular login fields are no longer visible, ADP has usually
    // accepted the credentials and we can navigate directly to the Work
    // Features page. This avoids waiting forever on a generic post-login page.
    const userInput = await findUsernameInput(page, 250);
    const passInput = await findPasswordInput(page, 250);
    if (!userInput && !passInput) {
      await page.waitForTimeout(1500);
      return;
    }

    if (await isLikelyLoggedIn(page)) return;
    await page.waitForTimeout(750);
  }

  if (!headless) {
    console.log('\nI could not confirm that ADP finished logging in automatically. Complete any remaining login/MFA step in the browser.');
    await ask('When ADP is past the login screen, press Enter here... ');
  } else {
    throw new Error('Could not confirm ADP login in headless mode.');
  }
}

async function navigateToWorkFeaturesPage(page) {
  if (env('TEAM_SCHEDULE_URL')) return page;

  const workFeaturesUrl = env('ADP_WORK_FEATURES_URL', DEFAULT_WORK_FEATURES_URL);
  if (!workFeaturesUrl) return page;

  console.log(`Navigating to ADP My Work Features page: ${workFeaturesUrl}`);
  await page.goto(workFeaturesUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return page;
}

async function navigateToTeamSchedule(page, context) {
  const directUrl = env('TEAM_SCHEDULE_URL');
  if (directUrl) {
    console.log(`Going directly to TEAM_SCHEDULE_URL: ${directUrl}`);
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
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
  await page.waitForTimeout(5000);
  return page;
}

async function scrollVirtualGrid(page) {
  console.log('Scrolling page/grid to load virtualized rows...');
  await page.evaluate(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function scrollableElements() {
      return Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const style = window.getComputedStyle(el);
          const canScrollY = /(auto|scroll)/.test(style.overflowY || '');
          return canScrollY && el.scrollHeight > el.clientHeight + 80;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    }

    window.scrollTo(0, 0);
    await sleep(300);

    const candidates = [document.scrollingElement, ...scrollableElements()].filter(Boolean);
    for (const el of candidates.slice(0, 8)) {
      try {
        el.scrollTop = 0;
        await sleep(150);
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const step = Math.max(250, Math.floor(el.clientHeight * 0.8));
        for (let y = 0; y <= max + step; y += step) {
          el.scrollTop = Math.min(y, max);
          el.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(180);
        }
      } catch (_) {}
    }
  });
  await page.waitForTimeout(1500);
}

async function saveCapture(page, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = timestamp();
  const htmlPath = path.join(outputDir, `schedule_${stamp}.html`);
  const latestPath = path.join(outputDir, 'latest_schedule.html');
  const textPath = path.join(outputDir, `schedule_${stamp}.visible_text.txt`);
  const latestTextPath = path.join(outputDir, 'latest_visible_text.txt');
  const screenshotPath = path.join(outputDir, `schedule_${stamp}.png`);
  const metadataPath = path.join(outputDir, `schedule_${stamp}.metadata.json`);

  const html = await page.content();
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
    screenshot_file: await fileExists(screenshotPath) ? screenshotPath : null
  };
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return { htmlPath, latestPath, textPath, screenshotPath, metadataPath };
}

function runParser(htmlPath, outDir) {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const args = [
      'team_schedule_parser.py',
      htmlPath,
      '--out-dir', outDir,
      '--timezone', env('CALENDAR_TIMEZONE', 'America/Vancouver'),
      '--calendar-location', env('CALENDAR_LOCATION', ''),
      '--alarms', env('CALENDAR_ALARMS', '1440,180,60')
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

  const launchOptions = {
    headless,
    args: headless ? [] : ['--start-maximized']
  };

  const contextOptions = {
    viewport: headless ? { width: 1600, height: 1000 } : null,
    acceptDownloads: true
  };

  let browser = null;
  let context = null;
  let page = null;

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

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await attemptLogin(page);
    await waitForAuthToSettle(page);
    page = await navigateToWorkFeaturesPage(page);
    page = await navigateToTeamSchedule(page, context);
    await scrollVirtualGrid(page);
    const saved = await saveCapture(page, outputDir);
    await runParser(saved.latestPath, parsedOutDir);

    console.log('\nDone. Key files:');
    console.log(`- Captured HTML: ${saved.latestPath}`);
    console.log(`- Visible text:  ${path.join(outputDir, 'latest_visible_text.txt')}`);
    console.log(`- Parsed output: ${parsedOutDir}`);
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
