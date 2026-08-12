# Baixa automática de Contas a Pagar a partir do extrato

Status: proposto.

## Contexto

Hoje `contas_pagar` é 100% cadastrado e baixado manualmente: quando um boleto/conta chega (fornecedor, concessionária, tributo), o usuário cadastra em `contas_pagar` com `status='pendente'`. Quando paga, dá baixa manual — três caminhos na tela (`src/app/(app)/contas-pagar/page.tsx`), todos fazendo a mesma escrita:

```js
supabase.from("contas_pagar").update({ status: "pago", data_pagamento: dataPag }).eq("id", conta.id)
supabase.from("movimentacoes").insert({
  tipo: "saida", data: dataPag, valor: conta.valor, categoria_id: conta.categoria_id,
  observacao: `Pagamento: ${conta.fornecedor}...`, conta_pagar_id: conta.id
})
```

O `/extrato` (staging de OFX bancário, nunca escreve em produção) já consegue classificar lançamentos de saída por categoria, mas não sabe que uma dessas saídas é o pagamento de uma conta já cadastrada — hoje isso é descoberto e baixado manualmente, olhando o extrato físico do banco.

**O problema real**: a descrição do banco (`MEMO` do OFX) não tem nome de fornecedor limpo — vem truncada e com prefixos variáveis. Confirmado em arquivos OFX reais do usuário (`arquivos e extratos/santander_junho_export_{A,B}.ofx`):

```
PAGAMENTO DE BOLETO                COMPRE FACIL COMERCIO DE
PAGAMENTO DE BOLETO OUTROS BANCOS  COMPRE FACIL COM PROD A L
PAGAMENTO DE BOLETO OUTROS BANCOS  P SEVERINI NETTO COMERCIA
CONTA DE AGUA E ESGOTO EM CANAIS   INTERNET SABESP SAO PAULO
PAGAMENTO DARF EM CANAIS           INTERNET SIMPLES NACIONAL
```

E confirmado em `contas_pagar` real (consulta direta ao banco de produção) que o cadastro usa nomes **curtos**, não o nome longo do banco:

```
fornecedor: "SDB"            valor: 233.57  status: pendente  vencimento: 2026-08-16
fornecedor: "SDB"            valor: 233.57  status: pendente  vencimento: 2026-08-23
fornecedor: "Compre Facil "  valor: 298.95  status: pendente  vencimento: 2026-08-20
fornecedor: "Compre Facil "  valor: 298.95  status: pendente  vencimento: 2026-08-27
fornecedor: "Severini "      valor: 248.25/248.32  status: pendente
```

Isso já mostra, com dados reais, o risco que o usuário alertou: **o mesmo fornecedor pode ter mais de uma conta pendente com o mesmo valor exato ao mesmo tempo** (dois boletos de "Compre Facil" de R$298,95 abertos simultaneamente). Casar só por valor, ou só por nome, non é seguro. Casar pelos dois ao mesmo tempo reduz bastante o risco, mas não elimina esse caso — que precisa ficar explicitamente sinalizado, nunca adivinhado.

## Objetivo

Ao importar um extrato OFX, todo lançamento de **saída** é automaticamente testado contra `contas_pagar` pendentes (fornecedores, mas também concessionárias/tributos como SABESP, Energisa, IPTU, Simples Nacional — qualquer coisa cadastrada em `contas_pagar`, não só boletos de fornecedor). Quando o casamento é seguro, a baixa é gravada **na hora**, reaproveitando exatamente a mesma escrita que a baixa manual já faz hoje. O resultado da importação mostra um resumo auditável — quantas contas bateram, quantas ficaram ambíguas, quantas não bateram com nada (o que é normal: pode ter sido pago em dinheiro, na lotérica, por outra conta).

## Design

### 1. Escopo do casamento

Todo lançamento do extrato com `valor < 0` (saída) entra no motor de casamento — não fica restrito a nenhuma categoria específica. A regra de casamento (valor idêntico + nome batendo) é o filtro de segurança, não uma lista de categorias permitidas: uma "TARIFA BANCARIA" ou "ESTORNO" não tem nome de fornecedor para casar, então naturalmente nunca vai gerar falso positivo — não precisa de uma lista de exclusão.

### 2. Algoritmo de casamento

Para cada lançamento de saída do extrato, busca em `contas_pagar` as linhas com `status='pendente'` onde:

- **Valor idêntico**: `contas_pagar.valor === abs(lancamento.valor)` (comparação exata, não faixa).
- **Nome batendo**: `normalizarDescricao(contas_pagar.fornecedor)` aparece como **substring** em `lancamento.descricao_normalizada` — em qualquer posição, não só no início. Confirmado necessário pelos dados reais: o fornecedor cadastrado como `"Severini"` só bate se o teste for "contém", porque o banco escreve `"P SEVERINI NETTO COMERCIA"` (prefixo variável antes do nome). Reaproveita a função `normalizarDescricao` que já existe em `lib/ofx.ts` (lowercase, sem acento, sem pontuação) — nada novo a implementar aí.
- Sem filtro de data: o usuário confirmou que valor é o critério principal de desambiguação, não proximidade de vencimento. Uma janela de data serviria só pra excluir casos absurdos, mas nenhum caso real observado até agora precisou disso — fica de fora do escopo inicial (fácil de adicionar depois se aparecer um caso real que precise).

Resultado da busca, por lançamento:

| Candidatos encontrados | Ação |
|---|---|
| **Exatamente 1** | Baixa automática imediata (ver seção 3) |
| **2 ou mais** (empate — mesmo fornecedor, mesmo valor, mais de uma pendente) | Marcado como **ambíguo** — não decide sozinho, ver seção 4 |
| **0** | Lançamento segue o fluxo normal de hoje (classificação manual ou por `extrato_regra`), sem nenhuma mudança |

### 3. Baixa automática (candidato único)

Reaproveita **exatamente** a escrita que a baixa manual já faz — nenhum caminho de escrita novo em `contas_pagar`/`movimentacoes`:

```js
supabase.from("contas_pagar").update({ status: "pago", data_pagamento: lancamento.data_lancamento }).eq("id", conta.id)
supabase.from("movimentacoes").insert({
  tipo: "saida", data: lancamento.data_lancamento, valor: conta.valor, categoria_id: conta.categoria_id,
  observacao: `Pagamento: ${conta.fornecedor}${conta.descricao ? ` - ${conta.descricao}` : ""}`,
  conta_pagar_id: conta.id,
})
```

No `extrato_lancamento`, grava:
- `status = 'classificado'`, `classificado_em = now()`.
- `categoria` = nome da categoria vinculada à conta (`categorias_saida` via `conta.categoria_id`), ou `"Contas a pagar"` como rótulo genérico se a conta não tiver categoria definida (campo é nullable) — assim o lançamento entra no resumo por dia/categoria normalmente, junto dos classificados manualmente.
- **Novo campo** `conta_pagar_id uuid null references contas_pagar(id)` em `extrato_lancamento` — o vínculo de auditoria, no mesmo padrão que `movimentacoes.conta_pagar_id` já usa em produção. É o que permite a tela do `/extrato` mostrar, lançamento a lançamento, qual fornecedor foi baixado (o pedido explícito do usuário de "enxergar fornecedor por fornecedor, igual ao cadastro manual") sem precisar de join manual toda vez.

Reversão: nenhuma lógica nova — "Desfazer pagamento" já existe na tela de Contas a Pagar (`desfazerPagamento`) e já reverte esse exato tipo de escrita (apaga a `movimentacoes` vinculada, volta `contas_pagar.status` para `pendente`). Cobre o caso de uma baixa errada sem precisar construir nada além do que já existe.

### 4. Ambíguos — nunca adivinha

Quando 2+ candidatos empatam, o lançamento do extrato **não é baixado**. Os ids dos candidatos ficam gravados num novo campo `extrato_lancamento.contas_pagar_candidatas jsonb null` (array de ids — mesmo padrão de campo adicional simples que o projeto já usa, sem precisar de tabela nova). A UI do `/extrato` mostra, junto ao lançamento, "Baixa ambígua — N contas conferem" com um seletor listando cada candidato (fornecedor, valor, vencimento) lido a partir desses ids. O usuário escolhe qual — isso dispara a mesma escrita da seção 3, mas para a conta escolhida manualmente. Sem escolha, o lançamento segue como está (visível, não perdido) até o usuário decidir.

### 5. Resumo pós-importação

Card de resultado no mesmo padrão que já existe hoje pro OFX/relatório Pix (`"X lidas · Y novas · Z já existentes"`), estendido com os números da baixa automática:

> "18 lançamentos de saída · 12 baixados automaticamente · 1 ambíguo (revisar) · 5 sem conta pendente correspondente"

O último número **não é erro** — contas pendentes que não bateram continuam pendentes exatamente como estavam. Pode ser que tenham sido pagas por outro meio (dinheiro, lotérica) ou simplesmente ainda não foram pagas. O resumo existe para o usuário conferir rapidamente que "os boletos que eu sei que paguei pela conta realmente bateram", não para apontar isso como problema.

### 6. Quando isso roda

No mesmo fluxo síncrono que já existe hoje logo após o import do OFX (onde `aplicarRegras` já roda automaticamente) — o motor de casamento roda em seguida, sobre os lançamentos de saída recém-importados. Também disponível no botão "Reprocessar" já existente na tela, para rodar sobre lançamentos de saída ainda não resolvidos de importações antigas (por exemplo depois de cadastrar uma conta a pagar nova cujo pagamento já estava no extrato antes).

## Fora de escopo (por decisão explícita do usuário)

- **Pix Enviado** não entra neste motor — o usuário já tinha decidido antes que esses destinos variam e devem ficar sinalizados para classificação manual, não casados automaticamente.
- Lançar entrada (Pix recebido, cartão) direto em `movimentacoes` — capacidade separada, para depois desta.
- Criar `contas_pagar` automaticamente a partir do XML de NF-e — capacidade separada; o usuário quer testar essa parte antes de decidir se implementa (ideia: cadastro individual ou em massa a partir do XML). Não faz parte desta spec.
- Janela de proximidade de data entre pagamento e vencimento — sem caso real que precise disso ainda.

## Testes previstos

- Motor de casamento testado com dados sintéticos: candidato único (baixa), 2+ empatados por fornecedor+valor (ambíguo, usando o caso real de "Compre Facil" R$298,95 como base), zero candidatos (segue fluxo normal), nome batendo mas valor diferente (não casa), valor batendo mas nome de fornecedor diferente (não casa).
- Teste com nomes reais observados (`"P SEVERINI NETTO COMERCIA"` deve casar com fornecedor cadastrado `"Severini"`; `"SDB COMERCIO DE ALIMENTOS"` deve casar com `"SDB"`) para validar que o "contém" cobre os prefixos variáveis do banco.
- Teste E2E no Postgres real (staging, com contas de teste): importar um OFX simulando um pagamento de boleto real, confirmar que a baixa grava `contas_pagar.status='pago'` + `movimentacoes` vinculada, e que "desfazer pagamento" reverte corretamente.
