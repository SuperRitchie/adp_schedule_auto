#!/usr/bin/env node
/*
  ADP/UKG automatic schedule capture + parser runner.

  This script:
  1) Opens ADP/MyADP using Playwright.
  2) Attempts a normal username/password login from .env, if a login form appears.
  3) Waits for you to finish MFA/security checkpoint manually when required.
  4) Navigates from the Time landing page to Team Schedule.
  5) Scrolls the virtualized grid to load as many rows as possible.
  6) Saves the schedule HTML.
  7) Runs team_schedule_parser.py to create CSV/JSON and employee .ics files.

  It does not bypass MFA and it does not ask you to paste credentials into chat.
*/

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
require('dotenv').config();

const DEFAULT_START_URL = 'https://my.adp.com/#/time';

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

async function firstVisibleInput(page, selectors) {
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector).first();
      if (await locatorVisible(locator)) return locator;
    }
  }
  return null;
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

  const usernameSelectors = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="login" i]',
    'input[id*="login" i]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[type="text"]'
  ];

  const passwordSelectors = [
    'input[autocomplete="current-password"]',
    'input[type="password"]',
    'input[name*="password" i]',
    'input[id*="password" i]'
  ];

  const userInput = await firstVisibleInput(page, usernameSelectors);
  if (userInput) {
    console.log('Login form detected. Filling username...');
    await userInput.fill(username);
    await clickButtonLike(page, [/next/i, /continue/i, /sign in/i, /log in/i, /login/i], 800).catch(() => false);
    await page.waitForTimeout(1500);
  }

  const passInput = await firstVisibleInput(page, passwordSelectors);
  if (passInput) {
    console.log('Filling password...');
    await passInput.fill(password);
    await clickButtonLike(page, [/sign in/i, /log in/i, /login/i, /continue/i, /submit/i], 800).catch(() => false);
    await page.waitForTimeout(3000);
  }
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
    await waitUntilTimeLandingOrLoggedIn(page);
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
