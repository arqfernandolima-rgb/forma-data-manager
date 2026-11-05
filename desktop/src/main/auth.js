'use strict';
/**
 * Autodesk sign-in: OAuth 2.0 authorization code + PKCE (no client secret).
 * Register the APS app as "Desktop, Mobile, Single-Page App" with the callback
 * http://localhost:<port>/callback. The Data Connector API only accepts user
 * (3-legged) tokens, which is why a browser sign-in is needed at all.
 *
 * Tokens are stored encrypted (Electron safeStorage = Windows DPAPI, tied to the
 * Windows user). Refresh tokens rotate on every use and expire after ~15 days
 * without use, so the app refreshes at least daily while running.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');

const AUTH_BASE = 'https://developer.api.autodesk.com/authentication/v2';
const SCOPES = ['data:read', 'data:write', 'data:create', 'user-profile:read'];

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function redirectUri(port) {
  return `http://localhost:${port}/callback`;
}

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class Auth {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings
   * @param {string} o.tokenFile
   * @param {{isEncryptionAvailable():boolean, encryptString(s):Buffer, decryptString(b):string}} o.safeStorage
   * @param {(url:string)=>Promise<void>} o.openExternal
   * @param {typeof fetch} o.fetch
   */
  constructor({ getSettings, tokenFile, safeStorage, openExternal, fetch, log }) {
    this.getSettings = getSettings;
    this.tokenFile = tokenFile;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.fetch = fetch;
    this.log = log;
    this.tokens = this.load();
    this.refreshing = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.tokenFile);
      const json = this.safeStorage.isEncryptionAvailable() ? this.safeStorage.decryptString(raw) : raw.toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  save(tokens) {
    this.tokens = tokens;
    if (!tokens) {
      try {
        fs.unlinkSync(this.tokenFile);
      } catch {}
      return;
    }
    const json = JSON.stringify(tokens);
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new AuthError('Windows secure storage is unavailable, so sign-in tokens cannot be stored safely.', 'no_secure_storage');
    }
    fs.writeFileSync(this.tokenFile, this.safeStorage.encryptString(json));
  }

  get signedIn() {
    return !!this.tokens?.refresh_token;
  }

  get user() {
    return this.tokens?.user ?? null;
  }

  /** Full browser sign-in. Resolves once tokens are stored. */
  async signIn({ timeoutMs = 5 * 60_000 } = {}) {
    const { clientId, callbackPort } = this.getSettings();
    if (!clientId) throw new AuthError('Enter your APS client ID first.', 'no_client_id');
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const redirect = redirectUri(callbackPort);

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, redirect);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get('error');
        const ok = !err && url.searchParams.get('state') === state && url.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Forma Data Manager</title><body style="font-family:Segoe UI,system-ui,sans-serif;padding:48px;text-align:center;color:#222">` +
            (ok ? '<h2>Signed in</h2><p>You can close this tab and go back to Forma Data Manager.</p>' : `<h2>Sign-in failed</h2><p>${escapeHtml(url.searchParams.get('error_description') || err || 'State mismatch')}</p>`) +
            '</body>'
        );
        clearTimeout(timer);
        server.close();
        if (ok) resolve(url.searchParams.get('code'));
        else reject(new AuthError(url.searchParams.get('error_description') || err || 'Sign-in was not completed.', err || 'state_mismatch'));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new AuthError('Sign-in timed out after 5 minutes.', 'timeout'));
      }, timeoutMs);
      server.on('error', (e) => {
        clearTimeout(timer);
        reject(
          new AuthError(
            e.code === 'EADDRINUSE' ? `Port ${callbackPort} is already in use. Pick another callback port in Settings and update your APS app's callback URL to match.` : e.message,
            'listen_failed'
          )
        );
      });
      server.listen(callbackPort, '127.0.0.1', () => {
        const qs = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirect,
          scope: SCOPES.join(' '),
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        });
        this.openExternal(`${AUTH_BASE}/authorize?${qs}`).catch(reject);
      });
    });

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: clientId,
    });
    tokens.user = await this.fetchUser(tokens.access_token).catch(() => null);
    this.save(tokens);
    this.log?.info(`Signed in${tokens.user?.email ? ` as ${tokens.user.email}` : ''}`);
    return tokens.user;
  }

  async tokenRequest(params) {
    const res = await this.fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error_description || body.developerMessage || body.error || `HTTP ${res.status}`;
      throw new AuthError(`Autodesk sign-in failed: ${msg}`, body.error || `http_${res.status}`);
    }
    return { ...body, obtained_at: Date.now(), expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  }

  async fetchUser(accessToken) {
    const res = await this.fetch('https://api.userprofile.autodesk.com/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const u = await res.json();
    return { name: u.name || [u.given_name, u.family_name].filter(Boolean).join(' '), email: u.email, id: u.sub };
  }

  /** A valid access token, refreshing when it expires within 5 minutes. */
  async accessToken() {
    if (!this.tokens?.refresh_token) throw new AuthError('Not signed in.', 'signed_out');
    if (this.tokens.access_token && this.tokens.expires_at - Date.now() > 5 * 60_000) return this.tokens.access_token;
    return (await this.refresh()).access_token;
  }

  /** Refresh tokens are single-use, so concurrent callers share one refresh. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const { clientId } = this.getSettings();
        try {
          const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token, client_id: clientId, scope: SCOPES.join(' ') });
          next.user = this.tokens.user;
          this.save(next);
          return next;
        } catch (e) {
          if (/invalid_grant|expired|revoked/i.test(`${e.code} ${e.message}`)) {
            this.save(null);
            throw new AuthError('Your Autodesk sign-in expired. Sign in again.', 'signed_out');
          }
          throw e;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  signOut() {
    this.save(null);
    this.log?.info('Signed out');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = { Auth, AuthError, pkcePair, redirectUri, SCOPES };
