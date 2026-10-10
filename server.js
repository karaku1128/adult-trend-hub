const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const PORT = process.env.PORT || 3000;
const X_TOKEN = process.env.X_BEARER_TOKEN;
const DMM_API_ID = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_MS = Number(process.env.CACHE_SECONDS || 600) * 1000;
const cache = { x: { at: 0, data: null }, works: { at: 0, data: null } };

const X_QUERY = '(成人向け OR アダルト OR FANZA OR AV) has:videos lang:ja -is:retweet -is:reply';
function score(p) {
  const m = p.public_metrics || {};
  return (m.like_count || 0) + (m.retweet_count || 0) * 2 + (m.reply_count || 0) + (m.quote_count || 0) * 2;
}
async function getXPosts(force = false) {
  if (!force && cache.x.data && Date.now() - cache.x.at < CACHE_MS) return cache.x.data;
  if (!X_TOKEN) { const e = new Error('X_BEARER_TOKEN が未設定です。'); e.status = 503; throw e; }
  const params = new URLSearchParams({ query: X_QUERY, max_results: '100', 'tweet.fields': 'created_at,public_metrics,attachments,lang', expansions: 'attachments.media_keys,author_id', 'media.fields': 'media_key,type,preview_image_url', 'user.fields': 'username,name' });
  const r = await fetch('https://api.x.com/2/tweets/search/recent?' + params, { headers: { Authorization: `Bearer ${X_TOKEN}` } });
  if (!r.ok) { const e = new Error(`X API ${r.status}: ${(await r.text()).slice(0, 250)}`); e.status = r.status; throw e; }
  const json = await r.json();
  const users = new Map((json.includes?.users || []).map(u => [u.id, u]));
  const media = new Map((json.includes?.media || []).map(m => [m.media_key, m]));
  const items = (json.data || []).map(p => {
    const u = users.get(p.author_id) || {};
    const attached = (p.attachments?.media_keys || []).map(k => media.get(k)).filter(Boolean);
    return { id: p.id, text: (p.text || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 180), url: `https://x.com/${u.username || 'i'}/status/${p.id}`, username: u.username || '', displayName: u.name || u.username || 'Xユーザー', createdAt: p.created_at || null, metrics: p.public_metrics || {}, score: score(p), preview: attached.find(m => m.type === 'video' || m.type === 'animated_gif')?.preview_image_url || '' };
  }).sort((a,b) => b.score - a.score);
  cache.x = { at: Date.now(), data: items };
  return items;
}
async function getWorks(force = false) {
  if (!force && cache.works.data && Date.now() - cache.works.at < CACHE_MS) return cache.works.data;
  if (!DMM_API_ID || !DMM_AFFILIATE_ID) return { configured: false, items: [] };
  const params = new URLSearchParams({ api_id: DMM_API_ID, affiliate_id: DMM_AFFILIATE_ID, site: 'FANZA', service: 'digital', floor: 'videoa', hits: '20', sort: 'rank', output: 'json' });
  const r = await fetch('https://api.dmm.com/affiliate/v3/ItemList?' + params);
  if (!r.ok) { const e = new Error(`FANZA API ${r.status}`); e.status = r.status; throw e; }
  const json = await r.json();
  const items = (json.result?.items || []).map(x => ({ title: x.title || '作品情報', image: x.imageURL?.large || x.imageURL?.list || '', url: x.affiliateURL || x.URL || '', maker: x.iteminfo?.maker?.[0]?.name || '', date: x.date || '' })).filter(x => x.url);
  cache.works = { at: Date.now(), data: items };
  return { configured: true, items };
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, xConfigured: Boolean(X_TOKEN), affiliateConfigured: Boolean(DMM_API_ID && DMM_AFFILIATE_ID) });
  if (url.pathname === '/api/x-trends') {
    try { const items = await getXPosts(url.searchParams.get('refresh') === '1'); return send(res, 200, { items, updatedAt: new Date(cache.x.at).toISOString() }); }
    catch (e) { console.error(e.message); return send(res, e.status || 502, { error: 'Xのトレンド情報を取得できませんでした。', detail: e.status === 401 || e.status === 403 ? 'APIトークン、契約プラン、検索権限を確認してください。' : e.status === 429 ? 'API利用上限に達しました。時間をおいて再試行してください。' : e.message }); }
  }
  if (url.pathname === '/api/works') {
    try { const result = await getWorks(url.searchParams.get('refresh') === '1'); return send(res, 200, result); }
    catch (e) { console.error(e.message); return send(res, e.status || 502, { error: '作品情報を取得できませんでした。', detail: e.message }); }
  }
  const requested = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const full = path.join(PUBLIC_DIR, requested);
  fs.readFile(full, (err, data) => { if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8'); const ext = path.extname(full); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }; send(res, 200, data, types[ext] || 'application/octet-stream'); });
});
server.listen(PORT, () => console.log(`Adult Trend Hub listening on port ${PORT}`));
