# Correção de data de Pix recebido via relatório Pix (fim de semana/feriado)

Status: aprovado, aguardando implementação.

## Contexto

O extrato bancário (OFX) do Santander nunca posta lançamentos em sábado, domingo ou feriado — tudo que acontece nesses dias é atribuído ao próximo dia útil (`DTPOSTED`). Confirmado empiricamente no arquivo real de junho/2026 do usuário: das 18 datas distintas presentes em 67 lançamentos, **nenhuma cai em fim de semana**.

Isso é um problema porque o usuário usa esses dados também para **fechamento de caixa**, que precisa refletir o dia real em que o dinheiro entrou — não o dia em que o banco decidiu contabilizar.

A informação da data real **não existe em lugar nenhum do OFX** (não é um bug de parsing — o dado já vem descartado do banco). A única fonte com a data real é um relatório separado, específico de Pix, que o Santander permite exportar em Excel (`.xlsx`). Confirmado com uma amostra real: colunas `Data, Banco origem, Titularidade, Pagador, Tipo de lançamento, Identificador do pagamento, Valor, ID da Transação`. A coluna `ID da Transação` é o End-to-End ID padrão do Pix e embute a data/hora real da transação, confirmando que a `Data` da planilha está correta.

## Objetivo

Permitir que o usuário suba esse relatório de Pix (Excel) dentro do `/extrato` e o sistema corrija automaticamente a `data_lancamento` dos lançamentos "PIX RECEBIDO" já importados do OFX, usando o relatório como referência — sinalizando (não adivinhando) quando não houver certeza.

## Restrição fundamental: não existe chave em comum entre OFX e relatório Pix

O OFX não carrega o "ID da Transação" nem o "Identificador do pagamento" do relatório — o único campo presente nos dois é o **valor**. O casamento (matching) entre um lançamento do OFX e uma linha do relatório só pode ser feito por valor, dentro de uma janela de datas plausível.

## Design

### 1. Parser do relatório Pix (`lib/relatorio-pix.ts`)

Excel (`.xlsx`) é um `.zip` por dentro — reaproveita o extrator de zip já existente (`lib/zip.ts`) para abrir `xl/worksheets/sheet1.xml` e `xl/sharedStrings.xml`, sem nenhuma dependência nova.

- Lê a linha de cabeçalho e localiza as colunas pelo **nome** (`Data`, `Valor`, pelo menos — os outros campos ficam disponíveis mas não são usados no matching), não por letra fixa, pra tolerar pequenas mudanças de layout do banco.
- `Data` vem como texto `dd/mm/yyyy` → converte para `yyyy-mm-dd`.
- `Valor` já vem como número na célula.
- Cada linha vira `{ data: string; valor: number; pagador: string | null }`.
- Erros de arquivo inválido/corrompido seguem o mesmo padrão dos outros parsers (`RelatorioPixParseError`, mensagem com o nome do arquivo).

### 2. Motor de casamento (`lib/correcao-data-pix.ts`, função pura testável)

Entrada: lançamentos já importados do OFX com `categoria` indicando Pix recebido e sua `data_lancamento` atual, mais as linhas do relatório Pix.

Algoritmo, por conta bancária:

1. Agrupa as entradas do relatório por data real.
2. Para cada lançamento do OFX (ainda não corrigido), procura no relatório uma entrada de **mesmo valor** cuja data seja **igual ou anterior** à data atual do lançamento (o banco só atrasa, nunca adianta) — dentro de uma janela fixa de **até 5 dias antes** (cobre feriado prolongado emendado com fim de semana; janela generosa não aumenta risco de falso positivo porque a exigência de valor exatamente igual já é o filtro forte).
3. Valores duplicados **no mesmo dia** não são ambíguos — qualquer emparelhamento entre eles produz o resultado correto (são fungíveis). Confirmado com o usuário.
4. Valores duplicados em **dias diferentes** dentro da mesma janela **são ambíguos** — não há como saber qual lançamento do OFX pertence a qual dia. Esses casos **não são corrigidos automaticamente**; entram numa lista de divergências para revisão manual.
5. Entradas do relatório sem nenhum lançamento correspondente no OFX (contagem não bate) também viram divergência sinalizada, não são descartadas silenciosamente.
6. Lançamentos do OFX que não batem com nada no relatório permanecem com a data original (assume-se que são do próprio dia útil).

Saída: lista de correções `{ lancamentoId, dataAntiga, dataNova }` e lista de divergências (com valor, data do relatório, e o motivo).

### 3. Aplicação da correção (recomputa `ocorrencia`)

A constraint de deduplicação já existente (`conta_id, data_lancamento, valor, descricao_normalizada, ocorrencia`) usa `data_lancamento` — mudar a data exige recalcular `ocorrencia` para o novo grupo, senão a constraint pode colidir. A aplicação:

1. Calcula, para cada lançamento a corrigir, sua nova `ocorrencia` dentro do grupo de destino (`conta_id + data nova + valor + descricao_normalizada`), considerando tanto lançamentos já existentes nesse grupo quanto os outros que estão sendo movidos para lá na mesma operação.
2. Aplica as atualizações (data + ocorrência) lançamento por lançamento.
3. Nunca mexe em `categoria`, `status`, `revisado` ou qualquer outro campo — só `data_lancamento` e `ocorrencia`.

### 4. Tela

Novo bloco dentro da aba **Importar** do `/extrato`, abaixo do card de upload do `.ofx`: "Corrigir datas de Pix (fim de semana/feriado)". Upload do `.xlsx` do relatório Pix, botão com os três estados (processando/sucesso/erro), e ao final um resumo: "X lançamentos corrigidos · Y divergências para revisar". Divergências aparecem listadas (valor, data do relatório, motivo) para o usuário decidir manualmente — sem gravar nada errado por adivinhação.

## Fora de escopo

- Só cobre **Pix recebido**. Pix enviado, cartão, boleto etc. não são afetados.
- Não escreve em `movimentacoes`/`contas_pagar` — continua 100% staging.
- Não tenta detectar automaticamente "isso é fim de semana" — o motor de casamento funciona genericamente por data e valor, sem regra especial de dia da semana (cobre feriado do mesmo jeito).
- Não adiciona nenhuma dependência nova (reaproveita `lib/zip.ts`).

## Testes previstos

- `lib/relatorio-pix.ts`: parser testado com o `.xlsx` real fornecido pelo usuário (mesmo padrão de teste isomórfico usado nos outros parsers desta fase).
- `lib/correcao-data-pix.ts`: casamento testado com casos sintéticos (mesmo dia duplicado não é ambíguo; dias diferentes duplicado é ambíguo e não corrige; relatório sem correspondência vira divergência; janela de data respeitada) e com os dados reais (arquivo `.ofx` + `.xlsx` de junho do usuário) para validar o cenário real.
- Teste E2E no Postgres real simulando a correção de data + recomputo de `ocorrencia` sem violar a constraint.
