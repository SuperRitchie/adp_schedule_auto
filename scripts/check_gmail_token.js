#!/usr/bin/env node
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const { google } = require('googleapis');

loadEnvFiles();

const DEFAULT_SECRETS_DIR = path.resolve(envRaw('GOOGLE_SECRETS_DIR', '.secrets'));
const CREDENTIALS_PATH = path.resolve(envRaw('GOOGLE_CREDENTIALS_PATH', envRaw('GMAIL_CREDENTIALS_PATH', path.join(DEFAULT_SECRETS_DIR, 'gmail_credentials.json'))));
const TOKEN_PATH = path.resolve(envRaw('GOOGLE_TOKEN_PATH', envRaw('GMAIL_TOKEN_PATH', path.join(DEFAULT_SECRETS_DIR, 'gmail_token.json'))));

function loadEnvFiles() {
  for (const envPath of [path.resolve(__dirname, '..', '.env'), path.resolve(process.cwd(), '.env')]) {
    if (!fsSync.existsSync(envPath)) continue;
    dotenv.config({ path: envPath, override: false });
  }
}

function envRaw(name, fallback = '') {
  const value = process.env[name];
  return value !== undefined && value !== null && value !== '' ? value : fallback;
}

function decodeBase64(value, label) {
  try {
    return Buffer.from(String(value || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch (error) {
    throw new Error(`${label} could not be decoded as base64: ${error.message}`);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function materialize(envName, filePath, label) {
  if (await fileExists(filePath)) return;
  const encoded = envRaw(envName, '');
  if (!encoded) throw new Error(`${label} file was not found at ${filePath} and ${envName} is not set`);
  const decoded = decodeBase64(encoded, envName);
  JSON.parse(decoded);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, decoded, { encoding: 'utf8', mode: 0o600 });
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read from ${filePath}: ${error.message}`);
  }
}

function getClientConfig(credentials) {
  const clientConfig = credentials.installed || credentials.web || credentials.desktop;
  if (!clientConfig) throw new Error('google oauth client credentials must contain installed, web, or desktop');
  if (!clientConfig.client_id || !clientConfig.client_secret || !Array.isArray(clientConfig.redirect_uris) || clientConfig.redirect_uris.length === 0) {
    throw new Error('google oauth client credentials are missing client_id, client_secret, or redirect_uris');
  }
  return clientConfig;
}

function isInvalidGrant(error) {
  const text = [error?.message, error?.response?.data?.error, error?.response?.data?.error_description].filter(Boolean).join(' ');
  return /invalid[_-]?grant|token has been expired or revoked|bad request/i.test(text);
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!name || !domain) return '(unknown account)';
  return `${name.slice(0, 2)}***@${domain}`;
}

async function main() {
  await materialize('GOOGLE_CREDENTIALS_JSON_B64', CREDENTIALS_PATH, 'google oauth client credentials');
  await materialize('GOOGLE_TOKEN_JSON_B64', TOKEN_PATH, 'google oauth token');

  const credentials = await readJson(CREDENTIALS_PATH, 'google oauth client credentials');
  const token = await readJson(TOKEN_PATH, 'google oauth token');

  if (!token.refresh_token) {
    throw new Error('google oauth token is missing refresh_token. run npm run gmail:auth locally and replace GOOGLE_TOKEN_JSON_B64');
  }

  const { client_id, client_secret, redirect_uris } = getClientConfig(credentials);
  const oauth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oauth.setCredentials(token);
  oauth.on('tokens', async refreshed => {
    const merged = { ...token, ...refreshed, refresh_token: refreshed.refresh_token || token.refresh_token };
    await fs.writeFile(TOKEN_PATH, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  });

  try {
    await oauth.getAccessToken();
    const gmail = google.gmail({ version: 'v1', auth: oauth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log(`gmail oauth ok for ${maskEmail(profile.data.emailAddress)}`);
  } catch (error) {
    if (isInvalidGrant(error)) {
      throw new Error('google oauth refresh failed with invalid_grant. run npm run gmail:auth locally and replace GOOGLE_TOKEN_JSON_B64');
    }
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});