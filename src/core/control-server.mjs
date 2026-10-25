import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gugu Habitat</title><style>
:root{color-scheme:light dark;font:14px ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#f4f5f6;color:#202426}
main{max-width:760px;margin:40px auto;padding:0 20px}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #d6d9da;padding-bottom:16px}
h1{font-size:22px;margin:0;font-weight:650}.controls{display:flex;gap:8px}button{font:inherit;padding:8px 12px;border:1px solid #9ca3a6;border-radius:5px;background:white;color:#202426;cursor:pointer}button:disabled{opacity:.5;cursor:default}
section{padding:18px 0;border-bottom:1px solid #d6d9da}h2{font-size:14px;margin:0 0 12px;color:#4f585b}dl{display:grid;grid-template-columns:180px 1fr;gap:9px;margin:0}dt{color:#626b6e}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:13px ui-monospace,monospace;color:#30383a}
@media(max-width:520px){main{margin:22px auto}header{align-items:flex-start;gap:14px;flex-direction:column}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}}
@media(prefers-color-scheme:dark){body{background:#171a1b;color:#e6e9e9}button{background:#252a2b;color:#e6e9e9;border-color:#586164}header,section{border-color:#3d4446}dt,h2{color:#aeb7b9}pre{color:#d4dada}}
</style></head><body><main><header><h1>Gugu Habitat</h1><div class="controls"><button id="pause" type="button">Pause autonomy</button><button id="resume" type="button">Resume autonomy</button></div></header>
<section><h2>Runtime</h2><dl><dt>Autonomy</dt><dd id="autonomy">Loading</dd><dt>Heartbeat</dt><dd id="heartbeat">Loading</dd><dt>Channels</dt><dd id="channels">Loading</dd><dt>Last started</dt><dd id="started">-</dd><dt>Last completed</dt><dd id="completed">-</dd><dt>Last error</dt><dd id="error">-</dd></dl></section>
<section><h2>Last decision</h2><pre id="decision">-</pre></section></main><script>
const byId=id=>document.getElementById(id);async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});const s=await r.json();byId('autonomy').textContent=s.heartbeat.paused?'Paused':s.heartbeat.running?'Running':'Active';byId('heartbeat').textContent=Math.round(s.heartbeat.intervalMs/60000)+' min';byId('channels').textContent=s.channels.join(', ')||'None';byId('started').textContent=s.heartbeat.lastStartedAt||'-';byId('completed').textContent=s.heartbeat.lastCompletedAt||'-';byId('error').textContent=s.heartbeat.lastError||'-';byId('decision').textContent=JSON.stringify(s.heartbeat.lastResult,null,2)||'-';byId('pause').disabled=s.heartbeat.paused;byId('resume').disabled=!s.heartbeat.paused}catch{byId('autonomy').textContent='Unavailable'}}async function setAutonomy(action){await fetch('/api/autonomy/'+action,{method:'POST'});await refresh()}byId('pause').onclick=()=>setAutonomy('pause');byId('resume').onclick=()=>setAutonomy('resume');refresh();setInterval(refresh,5000);
</script></body></html>`;

function loopbackHost(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

export function createControlServer({ scheduler, channels, host = '127.0.0.1', port = 7862, clock = () => new Date() }) {
  if (!loopbackHost(host)) throw new TypeError('The control server must bind to a loopback address');
  if (!scheduler || typeof scheduler.status !== 'function' || typeof scheduler.pause !== 'function' || typeof scheduler.resume !== 'function') {
    throw new TypeError('A controllable heartbeat scheduler is required');
  }

  const server = http.createServer((request, response) => {
    const hostHeader = String(request.headers.host || '');
    let requestHost;
    try { requestHost = new URL(`http://${hostHeader}`).hostname; } catch {}
    if (!requestHost || !loopbackHost(requestHost)) return send(response, 403, { error: 'Loopback host required.' });

    if (request.method === 'GET' && request.url === '/') return send(response, 200, PAGE, 'text/html; charset=utf-8');
    if (request.method === 'GET' && request.url === '/api/status') {
      return send(response, 200, { at: clock().toISOString(), channels: channels.ids(), heartbeat: scheduler.status() });
    }
    if (request.method === 'POST' && (request.url === '/api/autonomy/pause' || request.url === '/api/autonomy/resume')) {
      const origin = request.headers.origin;
      if (origin) {
        let originHost;
        try { originHost = new URL(origin).hostname; } catch {}
        if (!originHost || !loopbackHost(originHost)) return send(response, 403, { error: 'Loopback origin required.' });
      }
      if (request.url.endsWith('/pause')) scheduler.pause();
      else scheduler.resume();
      return send(response, 200, { ok: true, heartbeat: scheduler.status() });
    }
    return send(response, 404, { error: 'Not found.' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({
        server,
        address: server.address(),
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}
