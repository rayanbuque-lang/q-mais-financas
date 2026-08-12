# Pix de fim de semana/feriado: importar do relatório Pix e não duplicar no OFX

Status: aprovado, aguardando implementação.

> Revisão: a primeira versão desta spec propunha corrigir a data de lançamentos
> já importados do OFX usando o relatório Pix como referência (update depois do
> fato). O usuário propôs um fluxo melhor, adotado aqui: importar o relatório
> Pix primeiro, com a data certa desde o início, e fazer o upload do OFX
> reconhecer e descartar o que já foi coberto. Mais simples e não precisa
> recalcular a chave de deduplicação de nenhum lançamento existente.

## Contexto

O extrato bancário (OFX) do Santander nunca posta lançamentos em sábado, domingo ou feriado — tudo cai no próximo dia útil (`DTPOSTED`). Confirmado empiricamente no arquivo real de junho/2026 do usuário: das 18 datas distintas presentes em 67 lançamentos, nenhuma cai em fim de semana. A informação da data real não existe em lugar nenhum do OFX — só existe num relatório separado, específico de Pix, exportável em Excel (`.xlsx`), com colunas `Data, Banco origem, Titularidade, Pagador, Tipo de lançamento, Identificador do pagamento, Valor, ID da Transação` (confirmado com amostra real; `ID da Transação` é o End-to-End ID padrão do Pix e embute a data/hora real).

O usuário usa esses dados também pra fechamento de caixa, que precisa refletir o dia real em que o dinheiro entrou.

## Objetivo

**Fluxo operacional do usuário**, confirmado por ele:

1. **Segunda-feira**: exporta o relatório Pix do fim de semana (pode conter sábado e domingo juntos no mesmo arquivo — cada linha tem sua própria data, vindas separadas por dia, nunca agrupadas/misturadas) e sobe no `/extrato`. Cada Pix entra com a **data real** do relatório.
2. **Terça-feira (ou quando for)**: sobe o OFX normal, que traz tudo — inclusive o "eco" dos Pix do fim de semana, todos carimbados com a data de segunda pelo banco. O sistema precisa reconhecer que parte desses lançamentos **já está no sistema** (importados na segunda, com a data certa) e **não duplicar** — só entra como lançamento novo o que sobrar depois de descontar o que já foi coberto.

Exemplo confirmado pelo usuário: 2 Pix de R$ 20,00 no fim de semana (1 sábado, 1 domingo) já importados via relatório na segunda. Na terça, o OFX mostra 3 lançamentos de R$ 20,00 datados segunda (2 são o eco do fim de semana + 1 é uma venda real de segunda). O sistema descarta 2 dessas 3 linhas (já cobertas) e importa só 1 como lançamento novo.

## Restrição fundamental: não existe chave em comum entre OFX e relatório Pix

O OFX não carrega o "ID da Transação" nem o "Identificador do pagamento" do relatório — o único campo em comum é o **valor**. O reconhecimento de "isso já foi importado" só pode ser feito por valor, dentro de uma janela de datas plausível (o banco só atrasa, nunca adianta).

## Design

### 1. Parser do relatório Pix (`lib/relatorio-pix.ts`)

Excel (`.xlsx`) é um `.zip` por dentro — reaproveita o extrator de zip já existente (`lib/zip.ts`) pra abrir `xl/worksheets/sheet1.xml` e `xl/sharedStrings.xml`, sem dependência nova.

- Lê a linha de cabeçalho e localiza as colunas pelo **nome** (`Data`, `Pagador`, `Valor`), não por letra fixa, pra tolerar pequenas mudanças de layout do banco.
- `Data` vem como texto `dd/mm/yyyy` → converte pra `yyyy-mm-dd`. Cada linha mantém sua própria data — o relatório pode conter várias datas diferentes no mesmo arquivo (ex.: sábado e domingo juntos) e isso é esperado, não é um problema a resolver.
- `Valor` já vem como número na célula.
- `ID da Transação` (E2E do Pix) é lido e guardado — é globalmente único e estável entre re-exports do mesmo relatório, ao contrário do FITID do OFX.
- Erros de arquivo inválido/corrompido seguem o mesmo padrão dos outros parsers (`RelatorioPixParseError`, mensagem com o nome do arquivo).

### 2. Importar o relatório Pix como lançamentos (nova ação na aba Importar)

Mesmo pipeline de sempre (`extrato_lancamento` + `aplicarRegras` + resumo), só que a fonte é o relatório Pix em vez do OFX:

- `data_lancamento`: a data real de cada linha do relatório (não precisa de correção).
- `valor`, `descricao`/`descricao_normalizada`: sintetizados a partir do pagador (ex.: `"PIX RECEBIDO " + pagador`), normalizados do mesmo jeito que o parser de OFX — assim as regras existentes ("pix recebido" → Pix Santander) continuam classificando automaticamente sem precisar de regra nova.
- `fitid`: usa o **ID da Transação** (E2E) do Pix como identificador — ao contrário do FITID do OFX, esse é estável entre reimportações do mesmo relatório, então reimportar o mesmo relatório não duplica (constraint natural já existente: `conta_id + data_lancamento + valor + descricao_normalizada + ocorrencia` continua valendo, com `ocorrencia` cobrindo o caso raro de dois Pix de mesmo valor no mesmo dia).
- Roda `aplicarRegras` nos recém-inseridos, igual à importação de OFX.

### 3. Upload do OFX passa a descartar o que já está coberto

Antes de inserir cada candidato "PIX RECEBIDO" vindo do OFX, verifica se já existe um lançamento na mesma conta que:

- tenha o **mesmo valor**,
- `descricao_normalizada` também case com o padrão de Pix recebido (evita casar por engano com boleto/cartão de valor coincidente),
- data **igual ou anterior** (até 5 dias antes — cobre feriado emendado com fim de semana),
- e ainda não tenha sido "reivindicado" por outra linha do OFX nesta mesma importação.

Se achar → **não insere essa linha do OFX** (já está coberta pelo lançamento do relatório Pix), marca o lançamento existente como reivindicado pra não descontar duas vezes. Se não achar (o "sobra" do exemplo) → insere normalmente, com a data do OFX (dia útil real).

Como isso é uma contagem (quantos já existem vs. quantos aparecem no OFX), não precisa resolver "qual lançamento é de qual dia" — só decidir quantos descartar. Isso elimina a ambiguidade que a primeira versão desta spec se preocupava em resolver.

O resumo pós-importação do OFX passa a mostrar também quantos foram descartados por já estarem cobertos pelo relatório Pix: "X lidas · Y novas · Z já existentes (FITID) · W já cobertas pelo relatório Pix".

### 4. Tela

Novo card na aba **Importar** do `/extrato`, ao lado do upload do `.ofx`: "Importar relatório Pix (fim de semana/feriado)" — upload do `.xlsx`, mesma conta selecionada, três estados (processando/sucesso/erro), resumo pós-importação nos mesmos moldes do OFX (lidas/novas/já existentes).

## Fora de escopo

- Só cobre Pix recebido. Pix enviado, cartão, boleto etc. não são afetados.
- Não escreve em `movimentacoes`/`contas_pagar` — continua 100% staging.
- Não faz nenhuma correção de dado já existente — o design elimina essa necessidade.
- Não adiciona dependência nova (reaproveita `lib/zip.ts`).

## Testes previstos

- `lib/relatorio-pix.ts`: parser testado com o `.xlsx` real fornecido pelo usuário — múltiplas datas no mesmo arquivo, valores, ID da Transação.
- Motor de descarte de duplicidade coberta: testado com casos sintéticos (2 de mesmo valor no fim de semana + 3 no OFX = 1 novo; nenhum lançamento prévio = todos novos; valor sem par prévio = importa normal) e com os dados reais do usuário.
- Teste E2E no Postgres real: importar relatório Pix (datas corretas), depois importar OFX simulando o "eco" de segunda, confirmar que só o excedente entra como novo.
