// Puxa as campanhas [PLL] da conta de anúncios (Meta/Facebook) AO VIVO via Graph API.
// Requer env: FB_ACCESS_TOKEN (token de usuário do sistema, permissão ads_read).
// Opcionais: FB_AD_ACCOUNT (default = Conta 01 - Mentoria), FB_API_VERSION.
import { autorizado } from './_auth.js';

const TOKEN = process.env.FB_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.FB_AD_ACCOUNT || '1353636702742936';
const API_VER = process.env.FB_API_VERSION || 'v21.0';
const PREFIXO = '[PLL]';

// tipos de ação que representam "lead/cadastro" (fallback quando 'results' não vem)
const TIPOS_LEAD = [
  'onsite_conversion.lead_grouped', 'lead',
  'offsite_conversion.fb_pixel_lead', 'onsite_web_lead',
  'complete_registration', 'offsite_conversion.fb_pixel_complete_registration',
  'onsite_conversion.complete_registration'
];

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
// spend/impressions vêm crus do Graph (ponto decimal). CTR idem. Sem formatação BR aqui.
function numCru(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function leadsDaLinha(row) {
  // preferir o "results" (resultado configurado da campanha = o que aparece no Gerenciador)
  if (Array.isArray(row.results) && row.results[0] && Array.isArray(row.results[0].values)) {
    return Math.round(numCru(row.results[0].values[0].value));
  }
  // fallback: maior valor entre os tipos de lead nas actions (evita somar evento duplicado)
  if (Array.isArray(row.actions)) {
    let max = 0;
    for (const a of row.actions) if (TIPOS_LEAD.includes(a.action_type)) max = Math.max(max, numCru(a.value));
    return Math.round(max);
  }
  return 0;
}

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  if (!TOKEN) return res.status(200).json({ erro: 'sem_token', totais: null, campanhas: [] });

  const q = req.query || {};
  // período: datas exatas (since/until) OU um preset do Facebook (this_month, last_30d, maximum…)
  const periodo = (q.since && q.until)
    ? `time_range=${encodeURIComponent(JSON.stringify({ since: q.since, until: q.until }))}`
    : `date_preset=${encodeURIComponent(q.preset || 'this_month')}`;
  // nível: campanha (padrão), conjunto de anúncios ou anúncio
  const NIVEIS = { campaign: 'campaign_name', adset: 'adset_name', ad: 'ad_name' };
  const level = NIVEIS[q.level] ? q.level : 'campaign';
  const nomeField = NIVEIS[level];
  const fields = `${nomeField},spend,impressions,clicks,ctr,cpc,results,cost_per_result,actions`;
  const filtering = JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: PREFIXO }]);
  const url = `https://graph.facebook.com/${API_VER}/act_${AD_ACCOUNT}/insights`
    + `?level=${level}&${periodo}`
    + `&filtering=${encodeURIComponent(filtering)}`
    + `&fields=${encodeURIComponent(fields)}&limit=500`;

  let j;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    j = await r.json();
  } catch (e) {
    return res.status(200).json({ erro: 'falha_fetch', detalhe: String(e), totais: null, campanhas: [] });
  }
  if (j.error) return res.status(200).json({ erro: 'graph_error', detalhe: j.error.message, totais: null, campanhas: [] });
  if (req.query && req.query.debug) return res.status(200).json(j); // inspeção do payload cru

  const linhas = (j.data || []).map((row) => {
    const investido = numCru(row.spend);
    const impressoes = Math.round(numCru(row.impressions));
    const cliques = Math.round(numCru(row.clicks));
    const leads = leadsDaLinha(row);
    return {
      nome: (row[nomeField] || '').replace(PREFIXO, '').trim(),
      investido, impressoes, cliques, leads,
      ctr: numCru(row.ctr),
      cpl: leads > 0 ? investido / leads : null
    };
  });

  // ranking só com campanhas que rodaram no período
  const ativas = linhas.filter((c) => c.investido > 0 || c.leads > 0);
  ativas.sort((a, b) => b.leads - a.leads || b.investido - a.investido);

  const investido = ativas.reduce((s, c) => s + c.investido, 0);
  const leads = ativas.reduce((s, c) => s + c.leads, 0);
  const impressoes = ativas.reduce((s, c) => s + c.impressoes, 0);
  const cliques = ativas.reduce((s, c) => s + c.cliques, 0);

  const totais = {
    investido, leads, impressoes, cliques,
    cpl: leads > 0 ? investido / leads : null,
    ctr: impressoes > 0 ? (cliques / impressoes) * 100 : null
  };

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  return res.status(200).json({ periodo, nivel: level, atualizadoEm: new Date().toISOString(), totais, campanhas: ativas });
}
