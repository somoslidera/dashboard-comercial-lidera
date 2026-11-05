// TEMPORÁRIO — lança vendas de Gerente que aconteceram ANTES da contagem existir (o LeadForge não reenvia webhook).
// A API não lista negociações por funil; só por pessoa. Então:
//   GET  /api/gerente-retro?nome=Fulano   (ou ?fone=5551...)  → mostra as negociações do funil Gerentes dessa pessoa
//   POST /api/gerente-retro?deal=<id>                         → conta a venda (só se estiver GANHA e ainda não contada)
// Mesmas chaves e mesma idempotência do lf-webhook (proc:{mes} vendag:{id}). Remover depois de usar.
import { autorizado } from './_auth.js';

const F_GERENTES = '21960f23-f48a-47ed-ab23-8d32a87e19d6';
const LF = 'https://api.leadforge.com.br/api/v1';

async function redis(cmd) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  return (await r.json()).result;
}
const br = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString();

async function lf(path) {
  const r = await fetch(LF + path, { headers: { 'X-API-Key': process.env.LEADFORGE_API_KEY } });
  if (!r.ok) throw new Error(`LeadForge ${r.status} em ${path.split('?')[0]}`);
  return r.json();
}

async function dealsDoLead(leadId) {
  const j = await lf(`/deals/search?lead_id=${encodeURIComponent(leadId)}`);
  return ((j && j.deals) || []).filter((d) => d.funnel_id === F_GERENTES);
}

export default async function handler(req, res) {
  if (!autorizado(req)) return res.status(401).json({ erro: 'nao_autorizado' });
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      const busca = q.fone ? `phone=${encodeURIComponent(q.fone)}` : `name=${encodeURIComponent(q.nome || '')}`;
      if (!q.fone && !q.nome) return res.status(400).json({ erro: 'passe ?nome= ou ?fone=' });
      const leads = ((await lf(`/leads/search?${busca}`)).leads || []).slice(0, 20);
      const out = [];
      for (const l of leads) {
        for (const d of await dealsDoLead(l.id)) {
          const iso = d.closed_at || d.updated_at;
          const mes = iso ? br(iso).slice(0, 7) : null;
          out.push({
            deal: d.id, lead: l.id, pessoa: l.full_name, titulo: d.title, status: d.status, valor: d.value,
            fechadaEm: d.closed_at, mes, jaContada: mes ? (await redis(['SISMEMBER', `proc:${mes}`, `vendag:${d.id}`])) === 1 : false
          });
        }
      }
      return res.status(200).json({ encontradas: out.length, negociacoes: out });
    }

    if (req.method === 'POST') {
      if (!q.deal || !q.lead) return res.status(400).json({ erro: 'passe ?deal=&lead=' });
      const d = (await dealsDoLead(q.lead)).find((x) => x.id === q.deal);
      if (!d) return res.status(404).json({ erro: 'negociacao nao encontrada no funil Gerentes' });
      if (d.status !== 'won') return res.status(409).json({ erro: `negociacao nao esta ganha (status ${d.status})` });
      const iso = d.closed_at || d.updated_at;
      const mes = br(iso).slice(0, 7), dia = br(iso).slice(0, 10);
      if ((await redis(['SADD', `proc:${mes}`, `vendag:${d.id}`])) !== 1) return res.status(200).json({ ok: true, jaEstavaContada: true, mes });
      const valor = parseFloat(d.value || '0') || 0;
      await redis(['INCR', `vg:count:${mes}`]);
      await redis(['INCRBYFLOAT', `vg:valor:${mes}`, valor]);
      await redis(['INCR', `vg:count:${dia}`]);
      await redis(['INCRBYFLOAT', `vg:valor:${dia}`, valor]);
      await redis(['SET', `vgm:${d.id}`, JSON.stringify({ mes, dia, valor })]);
      await redis(['SET', `dl:${d.id}`, q.lead]);
      await redis(['HSET', `vg:ids:${mes}`, d.id, valor]);
      return res.status(200).json({ ok: true, contada: { mes, dia, valor, titulo: d.title } });
    }
    return res.status(405).json({ erro: 'use GET ou POST' });
  } catch (e) {
    return res.status(200).json({ erro: String(e.message || e) });
  }
}
