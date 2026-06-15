#!/usr/bin/env node
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const { google } = require('googleapis');

loadEnvFiles();

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
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

function readQuestion(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, label) {
  let text;
  if (await fileExists(filePath)) {
    text = await fs.readFile(filePath, 'utf8');
  } else if (envRaw('GOOGLE_CREDENTIALS_JSON_B64', '') && label === 'google oauth client credentials') {
    text = decodeBase64(envRaw('GOOGLE_CREDENTIALS_JSON_B64'), 'GOOGLE_CREDENTIALS_JSON_B64');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, { encoding: 'utf8', mode: 0o600 });
  } else {
    throw new Error(`${label} file was not found at ${filePath}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid json: ${error.message}`);
  }
}

function getClientConfig(credentials) {
  const clientConfig = credentials.installed || credentials.web || credentials.desktop;
  if (!clientConfig) {
    throw new Error('google oauth client credentials must contain installed, web, or desktop');
  }
  if (!clientConfig.client_id || !clientConfig.client_secret || !Array.isArray(clientConfig.redirect_uris) || clientConfig.redirect_uris.length === 0) {
    throw new Error('google oauth client credentials are missing client_id, client_secret, or redirect_uris');
  }
  return clientConfig;
}

async function main() {
  const credentials = await readJson(CREDENTIALS_PATH, 'google oauth client credentials');
  const { client_id, client_secret, redirect_uris } = getClientConfig(credentials);
  const oauth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('open this url and approve gmail readonly access:');
  console.log(authUrl);
  const code = await readQuestion('paste the authorization code here: ');
  const { tokens } = await oauth.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('google did not return a refresh_token. revoke the app access, confirm the consent screen is in production, then run this again');
  }

  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
  console.log(`wrote google oauth token to ${TOKEN_PATH}`);
  console.log('encode it for github secrets with:');
  console.log(`base64 -i ${TOKEN_PATH} | pbcopy`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});