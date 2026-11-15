// 通話ページ (別オリジン・ログインなし) から呼ばれる Edge Function。
// アプリが発行したトークンを DB の call_action() で確かめ、部屋の情報を返す。
// join のときは Cloudflare の TURN 認証情報もその都度発行して返す (API トークンはフロントに置かない)。
//
// JWT 検証はオフでデプロイする (通話ページはログインしていないため)。代わりにトークンで確認する。
// シークレット: TURN_KEY_ID / TURN_KEY_API_TOKEN (Cloudflare Realtime の TURN キー)
//   未設定のときは STUN だけを返す (同じ Wi-Fi などではつながるが、モバイル回線ではつながらないことがある)
import postgres from 'npm:postgres@3.4.5';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

async function iceServers(): Promise<unknown[]> {
  const id = Deno.env.get('TURN_KEY_ID');
  const token = Deno.env.get('TURN_KEY_API_TOKEN');
  if (!id || !token) return STUN;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 4 * 60 * 60 }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const list = Array.isArray(d.iceServers) ? d.iceServers : [d.iceServers];
    // ポート 53 の URL はブラウザによってはタイムアウトの原因になるので外す (Cloudflare の推奨)
    return list.map((s: { urls: string | string[] }) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
    }));
  } catch (e) {
    console.error('turn failed', (e as Error).message);
    return STUN;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let token: unknown, action: unknown;
  try {
    ({ token, action } = await req.json());
  } catch (_) {
    return json({ error: 'bad_request' }, 400);
  }
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return json({ error: 'invalid' }, 400);
  if (action !== 'join' && action !== 'status' && action !== 'end') return json({ error: 'bad_action' }, 400);

  const [row] = await sql`select public.call_action(${token}, ${action}) as r`;
  const r = row.r as Record<string, unknown>;
  if (r.error) return json(r, r.error === 'over' ? 409 : 403);

  if (action === 'join') r.iceServers = await iceServers();
  return json(r);
});
