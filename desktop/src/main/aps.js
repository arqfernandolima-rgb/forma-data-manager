'use strict';
/**
 * Thin APS client: auth header, retries for 429/5xx (honoring Retry-After),
 * and error messages that say what to actually do.
 * Uses Electron's net.fetch in the app (Chromium network stack, so corporate
 * proxies and PAC files work); plain fetch in tests.
 */
const API = 'https://developer.api.autodesk.com';

class ApsError extends Error {
  constructor(message, { status, code, detail } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendly(status, body, url) {
  const raw = body?.detail || body?.developerMessage || body?.message || body?.reason || body?.errors?.[0]?.detail || (typeof body === 'string' ? body : '');
  const dc = url.includes('/data-connector/');
  if (status === 401) return 'Autodesk rejected the sign-in token. Sign in again.';
  if (status === 403 && dc)
    return `Data Connector refused the request (403). The signed-in user must be a hub (account) admin with Executive access, and the APS client ID must be added under Custom Integrations in this hub. ${raw}`.trim();
  if (status === 403) return `Access denied (403). Check that your APS client ID is added under Custom Integrations in this hub. ${raw}`.trim();
  if (status === 404) return `Not found (404): ${raw || url}`;
  if (status === 429 && dc) return 'Data Connector limit reached: 24 extraction jobs per rolling 24 hours, per hub and per user (jobs started in the web UI count too). Try again later.';
  if (status === 429) return 'Autodesk rate limit reached. Try again in a minute.';
  return `Autodesk API error ${status}${raw ? `: ${raw}` : ''}`;
}

class ApsClient {
  constructor({ auth, fetch, log }) {
    this.auth = auth;
    this.fetch = fetch;
    this.log = log;
  }

  async request(method, pathOrUrl, { body, retries = 4, headers = {} } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
    let attempt = 0;
    for (;;) {
      const token = await this.auth.accessToken();
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt++ < retries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApsError(`Network error talking to Autodesk: ${e.message}`, { code: 'network' });
      }
      if (res.status === 401 && attempt === 0) {
        // Token may have been revoked or clock skewed: force one refresh and retry.
        attempt++;
        await this.auth.refresh().catch(() => {});
        continue;
      }
      const isDcCreate = method === 'POST' && url.includes('/data-connector/');
      if ((res.status === 429 && !isDcCreate) || res.status >= 500) {
        if (attempt++ < retries) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : 1500 * 2 ** attempt);
          continue;
        }
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) throw new ApsError(friendly(res.status, json ?? text, url), { status: res.status, detail: json ?? text });
      return json;
    }
  }

  get(p, o) {
    return this.request('GET', p, o);
  }
  post(p, body, o) {
    return this.request('POST', p, { ...o, body });
  }
  del(p, o) {
    return this.request('DELETE', p, o);
  }
  patch(p, body, o) {
    return this.request('PATCH', p, { ...o, body });
  }

  /** ACC / BIM 360 hubs the user can see. accountId = hub id without the "b." prefix. */
  async listHubs() {
    const res = await this.get('/project/v1/hubs');
    return (res?.data ?? [])
      .filter((h) => /bim360|acc/i.test(h.attributes?.extension?.type ?? ''))
      .map((h) => ({ id: h.id, accountId: h.id.replace(/^b\./, ''), name: h.attributes?.name ?? h.id, region: h.attributes?.region ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = { ApsClient, ApsError, friendly, API };
