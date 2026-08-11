# Validador de atestados

Site estático para verificar a autenticidade de atestados, hospedável no GitHub Pages.

O atestado impresso leva um QR Code. Quem quiser conferir escaneia, a página abre e
diz se o documento é autêntico e quais dados foram registrados na emissão.

## A ideia central

GitHub Pages não tem servidor nem banco de dados, e a chave impressa precisa ser
curta o bastante para ser digitada à mão: 16 dígitos, `1234-5678-9012-3456`.

Dezesseis dígitos são ~53 bits — não cabe neles nem os dados do atestado nem uma
assinatura (ECDSA P-256 são 512 bits só de assinatura). Então a chave não carrega
o documento: ela **aponta** para ele, num índice publicado junto do site.

Isso resolveria o problema e criaria outro — nome de paciente e de médico num
arquivo de repositório público. Daí as duas camadas:

1. **Cada registro do índice é cifrado** (AES-GCM) com uma chave derivada dos
   próprios 16 dígitos via PBKDF2. Quem tem a chave abre o seu registro; quem
   baixa `atestados.json` vê apenas blocos opacos.
2. **Dentro do registro cifrado está o token assinado** (ECDSA P-256), que só
   então é conferido contra a chave pública.

Consequências:

- **O arquivo publicado não revela nada.** Sem a chave, não há nome, data nem
  médico — só ruído.
- **Falsificar exige a chave privada.** Mesmo quem consiga escrever no
  repositório não produz um registro que passe na conferência de assinatura.
- **Descobrir uma chave revela um atestado, não permite forjar outros.** As duas
  camadas são independentes.
- **A verificação é local.** O navegador baixa dois arquivos estáticos e faz todo
  o resto sozinho; nenhuma consulta sai da máquina.

## Estrutura

```
docs/                      <- é isto que o GitHub Pages publica
  index.html, validar.js   página pública de validação
  estilo.css
  chaves-publicas.json     chaves públicas (pode e deve ser commitado)
  atestados.json           índice cifrado dos atestados emitidos (idem)
  emitir/                  ferramenta interna de emissão
  lib/qr.js                codificador de QR Code, sem dependências
  lib/token.js             formato do token, assinatura e verificação
  lib/indice.js            chave de 16 dígitos, derivação e cifragem
tools/
  gerar-chaves.mjs         gera um par de chaves
  emitir.mjs               emite um atestado pela linha de comando
  servidor.mjs             servidor local para testar antes de publicar
  testar.mjs               testes do fluxo completo
  testar-qr.mjs            confere o codificador de QR contra o jsQR
chaves-privadas/           NUNCA vai para o repositório (está no .gitignore)
```

## Passo a passo

### 1. Gerar o par de chaves

```bash
node tools/gerar-chaves.mjs
```

Isso cria `docs/chaves-publicas.json` (vai para o repositório) e
`chaves-privadas/<kid>.json` (**nunca** vai).

Opcionalmente dá para nomear a entidade emissora:

```bash
node tools/gerar-chaves.mjs "NOME DA ENTIDADE"
```

O nome fica ligado à chave, não ao atestado — assim não pode ser forjado por quem
preenche o formulário nem ocupa espaço no QR. Sem ele, a página de validação não
nomeia emissor nenhum e continua afirmando apenas o que de fato conferiu: que a
assinatura bate e que os dados não foram alterados.

**Faça backup da chave privada agora**, em local seguro e fora do computador de
trabalho. Perdê-la significa não conseguir emitir novos atestados com aquele kid
(os já emitidos continuam válidos). Vazá-la significa que qualquer pessoa passa a
conseguir forjar atestados que a página aceita como verdadeiros.

### 2. Testar localmente

```bash
node tools/servidor.mjs
```

Abre em `http://localhost:4173/` (validação) e `http://localhost:4173/emitir/`
(emissão). É preciso um servidor de verdade porque o site usa módulos ES, que o
navegador recusa carregar por `file://`.

### 3. Publicar no GitHub Pages

1. Crie um repositório **público** (o GitHub Pages gratuito exige repositório público —
   isso não é problema aqui, já que só a chave pública é publicada).
2. Faça o push do projeto.
3. Em **Settings → Pages**, escolha a branch e a pasta **`/docs`**.
4. O site fica em `https://<usuario>.github.io/<repositorio>/`.

Confirme que `chaves-privadas/` **não** foi para o repositório:

```bash
git ls-files | grep -i privada
```

O comando não deve devolver nada.

### 4. Emitir um atestado

Pela linha de comando:

```bash
node tools/emitir.mjs "NOME DO PACIENTE" "NOME DO MEDICO" 2026-08-11
```

Ou pela interface: abra `.../emitir/`, carregue o arquivo da chave privada uma vez
(ela fica guardada naquele navegador em formato não-extraível — nem a própria
página consegue lê-la de volta, só pedir assinaturas), informe o endereço da
página de validação e preencha os dados.

Em ambos os casos sai a chave de 16 dígitos e o QR Code para imprimir.

**Anote a chave na hora.** Ela não é guardada em texto claro em lugar nenhum, nem
no arquivo publicado. Perdida a chave, o registro correspondente não pode mais ser
aberto por ninguém — nem por você.

### 4.1. Publicar o registro

A chave só passa a funcionar depois que `docs/atestados.json` estiver publicado.
O comando de linha já grava direto no arquivo; a interface oferece um botão para
baixá-lo. Em seguida:

```bash
git add docs/atestados.json && git commit -m "novo atestado" && git push
```

Esse é o custo real desta arquitetura: **emitir exige um commit**. Para volume
baixo é irrelevante; para volume alto, vale automatizar o push.

### 5. Rodar os testes

```bash
npm install && npm run testar && npm run testar:qr
```

`testar` cobre emissão, verificação, rejeição de payload adulterado, de assinatura
adulterada, de assinatura de chave estranha, de kid desconhecido, de entrada
malformada, limites de tamanho de campo e rotação de chaves.

`testar:qr` confere o codificador de QR — que foi escrito do zero para o site não
depender de CDN — contra o decodificador jsQR, em todas as versões e níveis usados,
inclusive com acentuação.

## Privacidade e LGPD

Atestado médico envolve dado pessoal sensível. O desenho leva isso em conta:

- **O arquivo publicado é opaco.** `atestados.json` não contém nome, data nem
  médico legíveis — só registros cifrados. Um teste automatizado verifica isso.
- **A chave vai no fragmento da URL (`#`), nunca em query string.** O fragmento não
  é enviado ao servidor: nem a chave entra em log do GitHub ou em `Referer`.
- **Só existem três campos:** paciente, médico e data da consulta. Não há CID, CPF,
  período de afastamento nem número de atestado. O que não está declarado em
  `CAMPOS` não entra no token, portanto não existe em lugar nenhum.
- **Nada é transmitido.** A verificação é local ao navegador. Sem analytics, sem
  requisição externa, sem CDN.
- **A página tem um botão "Nova consulta"** que apaga os dados da tela e a chave do
  endereço, para uso em computador compartilhado.

Quem tem a chave de 16 dígitos lê aqueles três campos. É inerente à finalidade — a
pessoa que confere precisa ver o que está conferindo — e limitado a um atestado por
chave.

## Limites conhecidos

- **Emitir exige um commit.** A chave só funciona depois que `docs/atestados.json`
  chega ao repositório. É o preço de ter chave curta sem servidor.
- **Revogar é remover o registro** de `atestados.json` e dar push. Isso veio de
  brinde com o índice: na arquitetura anterior, de token autocontido, não existia.
- **Chave perdida é registro perdido.** Os 16 dígitos são a única forma de decifrar
  o registro; não há cópia em claro em lugar nenhum, por construção.
- **Uma chave de 16 dígitos são ~53 bits.** Com PBKDF2 a 600 mil iterações, cada
  tentativa custa ~125 ms num navegador. Varrer o espaço todo é inviável na
  prática, mas é um número finito: se algum dia precisar de mais margem, aumente
  `ITERACOES_PADRAO` ou passe a chave para alfanumérica. Índices já publicados
  continuam funcionando, porque cada arquivo guarda os próprios parâmetros.
- **Se a chave privada vazar, todos os atestados daquele kid ficam suspeitos.** A
  saída é gerar um novo par (`gerar-chaves.mjs` cria um kid novo automaticamente) e
  remover o kid comprometido de `chaves-publicas.json`. Os atestados legítimos
  assinados por ele deixam de validar junto — por isso o cuidado com a chave é o
  ponto crítico de todo o sistema.
- **O tamanho dos campos é limitado** (ver `CAMPOS` em `docs/lib/token.js`) porque
  cada caractere aumenta o QR. Nos limites máximos o QR chega a 93×93 módulos, o que
  exige uns 41 mm impressos. A tela de emissão sempre mostra o tamanho mínimo
  recomendado para o código gerado.
- **A página não prova que o atestado é verdadeiro do ponto de vista médico** — prova
  que foi emitido por quem detém a chave e que não foi alterado depois.
- **Isto não é ICP-Brasil.** A assinatura é real, mas com chave própria. ICP-Brasil
  exige certificado emitido por uma AC credenciada pelo ITI; escrever "padrão
  ICP-Brasil" numa página que usa chave autoassinada seria declaração falsa. Se for
  preciso validade jurídica desse nível, o caminho é o médico assinar com o
  certificado ICP-Brasil dele e a conferência correr no verificador oficial do ITI.
- **Requer navegador com Web Crypto e módulos ES**: Chrome/Edge 63+, Firefox 60+,
  Safari 11+. Na prática, qualquer celular dos últimos dez anos.
