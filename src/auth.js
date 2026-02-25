import { google } from "googleapis";
import crypto from "node:crypto";
import http from "node:http";
import open from "open";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the app directory: for a compiled binary, use the binary's location.
// For node/bun script mode, use the project root.
function getAppDir() {
  const execName = path.basename(process.execPath);
  if (execName === "node" || execName === "bun") {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(__dirname, "..");
  }
  return path.dirname(process.execPath);
}

const APP_DIR = getAppDir();
const CREDENTIALS_DIR = path.join(APP_DIR, "credentials");
const ACCOUNTS_PATH = path.join(CREDENTIALS_DIR, "accounts.json");
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, "credentials.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

async function loadCredentials() {
  try {
    const content = await fs.readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    throw new Error(
      `Missing ${CREDENTIALS_PATH}.\n` +
        "Download your OAuth 2.0 Client ID credentials from the Google Cloud Console\n" +
        "and save them as credentials/credentials.json",
    );
  }
}

async function loadAccounts() {
  try {
    const content = await fs.readFile(ACCOUNTS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveAccounts(accounts) {
  await fs.mkdir(path.dirname(ACCOUNTS_PATH), { recursive: true });
  await fs.writeFile(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

function getOAuth2Client(credentials) {
  const { client_id, client_secret } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, "http://localhost:3000/oauth2callback");
}

/**
 * Fetch the email address for an authenticated client.
 */
async function getAccountEmail(oAuth2Client) {
  const oauth2 = google.oauth2({ version: "v2", auth: oAuth2Client });
  const res = await oauth2.userinfo.get();
  return res.data.email;
}

/**
 * Run the interactive browser OAuth flow. Returns { client, email }.
 * @param {string} [loginHint] - Email to pre-select on Google's sign-in page.
 */
async function authenticateInteractive(credentials, loginHint) {
  const oAuth2Client = getOAuth2Client(credentials);

  const state = crypto.randomBytes(16).toString("hex");

  const authOptions = {
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
  };
  if (loginHint) authOptions.login_hint = loginHint;
  const authUrl = oAuth2Client.generateAuthUrl(authOptions);

  const AUTH_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

  const tokens = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost:3000");
        if (url.pathname !== "/oauth2callback") return;

        const returnedState = url.searchParams.get("state");
        if (returnedState !== state) {
          res.end("Invalid state parameter. Authentication rejected.");
          reject(new Error("OAuth state mismatch — possible CSRF"));
          server.close();
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.end("No authorization code received.");
          reject(new Error("No authorization code received"));
          return;
        }

        const { tokens } = await oAuth2Client.getToken(code);
        res.end("Authentication successful! You can close this tab and return to the terminal.");
        server.close();
        resolve(tokens);
      } catch (err) {
        res.end("Authentication failed.");
        reject(err);
      }
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Authentication timed out — no response within 2 minutes"));
    }, AUTH_TIMEOUT_MS);

    server.on("close", () => clearTimeout(timeout));

    server.listen(3000, () => {
      console.log("\nOpening browser for Google authentication...\n");
      open(authUrl);
    });
  });

  oAuth2Client.setCredentials(tokens);
  const email = await getAccountEmail(oAuth2Client);

  // Persist the token keyed by email
  const accounts = await loadAccounts();
  accounts[email] = tokens;
  await saveAccounts(accounts);

  return { client: oAuth2Client, email };
}

/**
 * Restore a client from a saved token, refreshing if expired.
 */
async function restoreClient(credentials, email, tokens) {
  const oAuth2Client = getOAuth2Client(credentials);
  oAuth2Client.setCredentials(tokens);

  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    const { credentials: refreshed } = await oAuth2Client.refreshAccessToken();
    oAuth2Client.setCredentials(refreshed);

    const accounts = await loadAccounts();
    accounts[email] = refreshed;
    await saveAccounts(accounts);
  }

  return oAuth2Client;
}

/**
 * Load all saved accounts. Returns an array of { client, email }.
 */
export async function authorizeAll() {
  const credentials = await loadCredentials();
  const accounts = await loadAccounts();
  const results = [];

  for (const [email, tokens] of Object.entries(accounts)) {
    try {
      const client = await restoreClient(credentials, email, tokens);
      results.push({ client, email });
    } catch {
      // Skip accounts that fail to restore (revoked, etc.)
      console.warn(`  Warning: could not restore session for ${email}, skipping.`);
    }
  }

  return results;
}

/**
 * Add a new account via interactive OAuth. Returns { client, email }.
 * @param {string} [loginHint] - Email to pre-select on Google's sign-in page.
 */
export async function addAccount(loginHint) {
  const credentials = await loadCredentials();
  return authenticateInteractive(credentials, loginHint);
}

/**
 * Remove a saved account by email.
 */
export async function removeAccount(email) {
  const accounts = await loadAccounts();
  delete accounts[email];
  await saveAccounts(accounts);
}
