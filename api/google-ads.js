// Puxa as campanhas do Google Ads AO VIVO via Google Ads API (REST).
// Espelha o /api/facebook: devolve { totais, campanhas, nivel }.
// Envs necessárias (Vercel):
//   GOOGLE_ADS_DEVELOPER_TOKEN  - developer token (API Center do Google Ads)
//   GOOGLE_ADS_CLIENT_ID        - OAuth client id (Google Cloud)
//   GOOGLE_ADS_CLIENT_SECRET    - OAuth client secret
//   GOOGLE_ADS_REFRESH_TOKEN    - refresh token (escopo adwords)
//   GOOGLE_ADS_CUSTOMER_ID      - id da conta que roda as campanhas (10 dígitos, sem traços)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID- (opcional) id da conta gerente/MCC, se houver
import { autorizado } from './_auth.js';

const API_VER = process.env.GOOGLE_ADS_API_VERSION || 'v18';
const DEV_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/\D/g, '');
const LOGIN_CID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, '');

// troca o refresh token por um access token (válido ~1h)
async function obterAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth: ' + (j.error_description || j.error || 'sem access_token'));
  return j.access_token;
}

// intervalo GAQL a partir de since/until (YYYY-MM-DD) ou de um preset
function trechoData(q) {
  if (q.since && q.until) return `segments.date BETWEEN '${q.since}' AND '${q.until}'`;
  const P = {
    this_month: 'THIS_MONTH', last_month: 'LAST_MONTH',
    last_7d: 'LAST_7_DAYS', last_30d: 'LAST_30_DAYS', last_90d: 'LAST_90_DAYS',
    today: 'TODAY', maximum: 'ALL_TIME'
  };
  return `segments.date DURING ${P[q.preset] || 'THIS_MONTH'}`;
}

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !CUSTOMER_ID) {
    return res.status(200).json({ erro: 'sem_credenciais', totais: null, campanhas: [] });
  }

  const q = req.query || {};
  // nível: campanha (padrão), grupo de anúncios ou anúncio
  const NIVEIS = {
    campaign: { nome: 'campaign.name', id: 'campaign.id', sub: null, from: 'campaign' },
    adset:    { nome: 'ad_group.name', id: 'ad_group.id', sub: 'campaign.name', from: 'ad_group' },
    ad:       { nome: 'ad_group_ad.ad.name', id: 'ad_group_ad.ad.id', sub: 'ad_group.name', from: 'ad_group_ad' }
  };
  const level = NIVEIS[q.level] ? q.level : 'campaign';
  const N = NIVEIS[level];
  const campos = [N.nome, N.id, N.sub, 'metrics.cost_micros', 'metrics.impressions', 'metrics.clicks', 'metrics.ctr', 'metrics.conversions'].filter(Boolean);
  const gaql = `SELECT ${campos.join(', ')} FROM ${N.from} WHERE ${trechoData(q)} AND metrics.cost_micros > 0`;

  let linhas;
  try {
    const token = await obterAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'developer-token': DEV_TOKEN,
      'Content-Type': 'application/json'
    };
    if (LOGIN_CID) headers['login-customer-id'] = LOGIN_CID;
    const url = `https://googleads.googleapis.com/${API_VER}/customers/${CUSTOMER_ID}/googleAds:searchStream`;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: gaql }) });
    const j = await r.json();
    if (q.debug) return res.status(200).json(j);
    if (j.error || (Array.isArray(j) && j[0] && j[0].error)) {
      const err = j.error || j[0].error;
      return res.status(200).json({ erro: 'google_error', detalhe: (err.message || JSON.stringify(err)), totais: null, campanhas: [] });
    }
    // searchStream devolve um array de batches, cada um com results[]
    const results = [].concat(...(Array.isArray(j) ? j : [j]).map((b) => b.results || []));
    linhas = results;
  } catch (e) {
    return res.status(200).json({ erro: 'falha_fetch', detalhe: String(e), totais: null, campanhas: [] });
  }

  // caminho encurtado p/ ler campos aninhados do resultado (ex.: "campaign.name")
  const pega = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  const ativas = linhas.map((row) => {
    const investido = (Number(pega(row, 'metrics.costMicros') || 0)) / 1e6;
    const impressoes = Number(pega(row, 'metrics.impressions') || 0);
    const cliques = Number(pega(row, 'metrics.clicks') || 0);
    const leads = Math.round(Number(pega(row, 'metrics.conversions') || 0));
    const nome = String(pega(row, camelPath(N.nome)) || '').trim();
    const sub = N.sub ? String(pega(row, camelPath(N.sub)) || '').trim() : null;
    const id = String(pega(row, camelPath(N.id)) || '') || null;
    return {
      id, nome: nome || '—', sub,
      investido, impressoes, cliques, leads,
      ctr: Number(pega(row, 'metrics.ctr') || 0) * 100,  // Google manda fração; vira %
      cpl: leads > 0 ? investido / leads : null
    };
  }).filter((c) => c.investido > 0 || c.leads > 0);

  ativas.sort((a, b) => b.leads - a.leads || b.investido - a.investido);

  const soma = (k) => ativas.reduce((s, c) => s + (c[k] || 0), 0);
  const investido = soma('investido'), leads = soma('leads'), impressoes = soma('impressoes'), cliques = soma('cliques');
  const totais = {
    investido, leads, impressoes, cliques,
    cpl: leads > 0 ? investido / leads : null,
    ctr: impressoes > 0 ? (cliques / impressoes) * 100 : null
  };

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  return res.status(200).json({ fonte: 'google', nivel: level, atualizadoEm: new Date().toISOString(), totais, campanhas: ativas });
}

// a API REST devolve os campos em camelCase (campaign.name -> campaign.name; cost_micros -> costMicros).
// nomes de recurso (campaign.name) já vêm como "campaign":{"name":...}; só métricas viram camelCase.
function camelPath(path) {
  return path.split('.').map((seg) => seg.replace(/_([a-z])/g, (_, c) => c.toUpperCase())).join('.');
}
