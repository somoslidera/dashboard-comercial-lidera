# Handoff — Dashboards Lidera (Comercial + Marketing)

Contexto completo para continuar este projeto em outra conta/sessão.

## O que é
Dashboard único em HTML para TV/monitor (tema escuro navy + dourado, fontes Fraunces/Figtree).
Um link só, com um **dropdown** no cabeçalho que alterna entre **Comercial** e **Marketing**. Tela de login.

## Onde vive / como publica
- **Repo (público, Git→Vercel auto-deploy):** github.com/somoslidera/dashboard-comercial-lidera — `index.html` na raiz.
- **No ar:** https://dashboard-comercial-lidera.vercel.app (Vercel, time Lidera Soluções, plano Hobby/Free).
- **Deploy:** editar → `git commit` → **`git push`** de `~/Downloads/dashboard-deploy` → Vercel redeploya em ~30s. (O Claude não dá push do ambiente dele; o usuário roda o push.)
- **Não pode virar Artifact do claude.ai** (CSP bloqueia fetch das APIs/planilha/fontes). Tem que ser servido pelo Vercel.
- Após mudar código do cliente, **recarregar a página** (o JS velho fica em cache na aba aberta).

## Arquivos
- `index.html` — página única. `#viewVendas` (comercial) + `#viewMarketing`, alternados pelo dropdown `.view-select`. Tema/tudo inline.
- `login.html` — tela de login.
- `/api/dados.js` — lê contadores do Redis → `{porMes, idxAuto, series, rastreioDiarioInicio, porFaixa}`. Params: `?since=&until=` (por dia), `?faixasMes=YYYY-MM` (funil por faixa).
- `/api/facebook.js` — Graph API insights das campanhas `[PLL]`. Params: `?preset=` ou `?since=&until=`; `?level=campaign|adset|ad`. Devolve `{totais, campanhas, nivel}`.
- `/api/lf-webhook.js` — recebe webhooks do LeadForge, incrementa contadores no Redis.
- `/api/login.js`, `/api/logout.js`, `/api/_auth.js` — login por senha única (cookie HMAC).

## Arquitetura de dados
- **CRM LeadForge → webhooks → `/api/lf-webhook` → Upstash Redis** (contadores por mês E por dia, fuso BR/UTC-3). A API do LeadForge NÃO lista em massa (`/leads/search` cap 20, `/deals/search` só por lead), por isso é tudo event-driven.
- **Facebook (Meta Ads) → Graph API** (env `FB_ACCESS_TOKEN`).
- **Mapa de clientes** = planilha Google Sheets (CSV client-side) no painel comercial.

## Variáveis de ambiente no Vercel (valores só lá, NUNCA no chat)
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Upstash Redis.
- `LF_WEBHOOK_SECRET` — valida o webhook (header `x-api-key`).
- `LEADFORGE_API_KEY` — chave da API do LeadForge (usada p/ buscar a faixa via `/deals/search`).
- `FB_ACCESS_TOKEN` — token do Facebook (Usuário do Sistema, ads_read, não expira). `FB_AD_ACCOUNT` (default 1353636702742936), `FB_API_VERSION` (default v21.0).
- `DASHBOARD_SENHA` + `AUTH_SECRET` — login (usuário padrão `lidera`, ou `DASHBOARD_USUARIO`). Login só é exigido quando `DASHBOARD_SENHA` existe.

## IDs do LeadForge (org 120cd5c5-08d0-4803-b6e4-3c5412cdf6bf)
- Funil **Pré Vendas**: `e72026a9-756b-4db0-ad9f-2aacc2a5a113`; Funil **Vendas**: `b765f6c0-49da-4ad1-9c78-447606006901`.
- Etapas Pré Vendas: N2 Agendamento `f5cc8371…`, N3 No-Show `f9e915a1…`, REUNIÃO REALIZADA `64af2954…`, **PERDA SDR `7184bfe4-539f-4f9c-b3a4-b59f6a277ee8`**, **LEAD DESQUALIFICADO `0ca30456-0b96-4452-a014-3a71db256270`**, LEADS POSTO `a970d601…`.
- GANHO (Vendas) `8cb7b698…`.
- Funis de rastreio (automação duplica o card p/ cá): Rastreio-Agendamentos `eba4042d-db40-436b-8efb-3c5d6602d756`, Rastreio-No-Show `a8bda2e1-e970-41bc-ab62-3158ead4ffc2`.
- Instância WhatsApp "posto" (lixo, NÃO conta): `8f8cb4b9-25fd-4f5d-93a1-e7dcf03fa338`.
- **Eventos ativos no webhook:** Negociação criada, ganha, finalizada (qualquer), Tag adicionada, Tag removida.

## Mapeamento das métricas (chaves Redis por mês `AAAA-MM` e por dia `AAAA-MM-DD`)
- **Leads** (`l:`) = `deal.created` no Pré Vendas (exclui instância do posto).
- **Oportunidades / SQL** (`o:`) = `deal.created` no Rastreio-Agendamentos.
- **No-show** (`n:`) = `deal.created` no Rastreio-No-Show.
- **Reuniões** (`r:`) = `deal.won` no Pré Vendas.
- **Vendas + faturamento** (`v:count:` / `v:valor:`) = `deal.won` no funil Vendas (valor = `deal.value`).
- **Desqualificados** (`d:`) = `deal.closed` no Pré Vendas com etapa LEAD DESQUALIFICADO ou PERDA SDR. **MQL = Leads − Desqualificados.**
- Idempotência: `proc:AAAA-MM` (SADD por deal.id).

## Facebook / Marketing
- Conta "Conta 01 - Mentoria": `1353636702742936`. Campanhas que começam com `[PLL]`.
- "Leads" = campo `results` do insight. Ranking por nível (campanha/conjunto/anúncio), com o nome do "pai" (conjunto/campanha) como subtítulo p/ desambiguar nomes repetidos.

## Funil por FAIXA de valor (Ideia 2)
- 6 faixas (etiqueta do formulário do Facebook → vira **tag na NEGOCIAÇÃO**, não no lead): `Até 50k`(f1) / `50k - 80k`(f2) / `80k - 100k`(f3) / `100k - 150k`(f4) / `150k - 300k`(f5) / `Acima 300k`(f6).
- **A faixa NÃO vem no evento de webhook** (`lead.tag_added` não diz qual tag; `/leads/search` não traz tags). Vem via **`GET /deals/search?lead_id={id}` → `deals[].tags[].name`**. O webhook (`faixaDoLead`/`obterFaixa`) consulta isso e cacheia `banda:{lead_id}`.
- Contadores por faixa/mês (SETs de lead_id): `fx:l:` `fx:sql:` `fx:r:` `fx:v:` `fx:d:` + `fx:vv:` (faturamento). `/api/dados` expõe `porFaixa` (mês atual) e `?faixasMes=`.
- **UI:** a faixa é um **FILTRO do funil de Marketing** (dropdown `#mktFaixa`: Todas + 6 faixas). O funil tem 5 etapas: **Leads → MQL → SQL → Reuniões → Vendas**. NÃO é um painel separado.
- FORWARD-ONLY: só coleta a partir de 22/07/2026 (sem backfill — API não lista em massa, testado exaustivamente).
- **Correção de tag:** o webhook trata `lead.tag_added`/`lead.tag_removed` → `ressincronizarFaixa()` reconsulta a faixa e MOVE o lead entre os SETs (l/sql/r/v/d, últimos 3 meses). Ressalva: o faturamento por faixa (`fx:vv`) NÃO é movido numa troca de tag pós-venda (raro).

## Estado atual (tudo FEITO e no ar, exceto onde indicado)
- ✅ Comercial + Marketing num link, dropdown, login, Facebook ao vivo.
- ✅ Custos nos KPIs do comercial (CPL, custo/op, custo/reunião, CAC) = investido FB / etapa, mesmo período.
- ✅ Registro por dia (a partir de 22/07); filtro Personalizado do comercial usa dia p/ datas recentes, mês p/ histórico.
- ✅ Ranking do marketing por nível (campanha/conjunto/anúncio) com subtítulo do pai.
- ⚠️ **Funil de marketing com filtro de faixa + Reuniões/Vendas (Ideia 2 redesenhada):** COMMITADO, **falta push + teste ao vivo** (último commit). Painel "Faixas" separado foi removido.

## Cuidados / aprendizados
- CRM guarda por mês (dia só a partir de 22/07); LeadForge não deixa backfill.
- Faixa mora na tag da NEGOCIAÇÃO, obtida via `/deals/search?lead_id=`.
- Áudio (sino de venda) precisa de 1 gesto na TV (overlay "Ativar som").
- Nunca colar segredos no chat.
- Depois de mudar o JS, recarregar a aba (cache).

**Próximo passo / o que eu quero:** [ESCREVA AQUI].
