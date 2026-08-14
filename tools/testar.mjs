// Testes do fluxo completo: emissão, verificação, adulteração e QR.
//
//   node tools/testar.mjs

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abrirRegistro, chaveCompleta, criarRegistro, formatarChave, gerarChave,
  indiceVazio, normalizarChave,
} from '../docs/lib/indice.js';
import { encodeQR } from '../docs/lib/qr.js';
import {
  camposParaExibir, emitirToken, gerarParDeChaves, importarChavePrivada,
  importarChavePublica, verificarToken,
} from '../docs/lib/token.js';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let ok = 0;
const falhas = [];
const checar = (nome, condicao, detalhe = '') => {
  if (condicao) ok++;
  else falhas.push(`${nome}${detalhe ? ' — ' + detalhe : ''}`);
};

// --- Preparação ----------------------------------------------------------

const kid = '2026-08';
const { privadaJwk, publicaJwk } = await gerarParDeChaves();
const chavePrivada = await importarChavePrivada(privadaJwk, true);
const chavePublica = await importarChavePublica(publicaJwk);
const chaves = { [kid]: { chave: chavePublica, entidade: 'AFABANES' } };

const dados = {
  pac: 'MARIA APARECIDA DA SILVA SANTOS',
  prof: 'DRA. JOANA PEREIRA DE ALMEIDA',
  em: '2026-08-11',
};

// --- Emissão e verificação ----------------------------------------------

const token = await emitirToken(dados, chavePrivada, kid);
checar('token tem duas partes', token.split('.').length === 2);

const r = await verificarToken(token, chaves);
checar('token válido é aceito', r.valido, r.erro);
checar('paciente preservado', r.payload?.pac === dados.pac);
checar('médico preservado', r.payload?.prof === dados.prof);
checar('kid informado', r.kid === kid);
checar('entidade vem da chave, não do token', r.entidade === 'AFABANES');
checar('entidade não trafega no token', !('ent' in (r.payload ?? {})));

// Chave sem entidade nomeada: valida igual, apenas sem nomear emissor.
const rSemEntidade = await verificarToken(token, { [kid]: { chave: chavePublica } });
checar('chave sem entidade continua validando', rSemEntidade.valido, rSemEntidade.erro);
checar('sem entidade, nenhum emissor é afirmado', rSemEntidade.entidade === undefined);

const exibicao = camposParaExibir(r.payload ?? {});
checar('data formatada em pt-BR',
  exibicao.some((c) => c.rotulo === 'Data da consulta' && c.valor === '11/08/2026'));
checar('exibe exatamente três campos', exibicao.length === 3, `tem ${exibicao.length}`);
checar('rótulos na ordem do print',
  exibicao.map((c) => c.rotulo).join('|') === 'Paciente|Médico|Data da consulta');

// Campo fora do conjunto declarado não pode entrar no token nem aparecer na tela.
const comExtra = await emitirToken({ ...dados, cid: 'J06.9', doc: '123.456.789-00' }, chavePrivada, kid);
const rExtra = await verificarToken(comExtra, chaves);
checar('campo não declarado é descartado na emissão',
  !('cid' in (rExtra.payload ?? {})) && !('doc' in (rExtra.payload ?? {})));
checar('nada sensível sobra no token', !/J06|123\.456/.test(atob(comExtra.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))));

// --- Adulteração ---------------------------------------------------------

const [payloadB64, sigB64] = token.split('.');

// Troca o nome do paciente mantendo a assinatura original.
const adulterado = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
adulterado.pac = 'JOAO FRAUDADOR';
const tokenAdulterado =
  Buffer.from(JSON.stringify(adulterado), 'utf8').toString('base64url') + '.' + sigB64;
const rAdulterado = await verificarToken(tokenAdulterado, chaves);
checar('payload adulterado é rejeitado', rAdulterado.valido === false, JSON.stringify(rAdulterado));

// Assinatura mexida.
const sigBytes = Buffer.from(sigB64, 'base64url');
sigBytes[10] ^= 0xff;
const rSig = await verificarToken(payloadB64 + '.' + sigBytes.toString('base64url'), chaves);
checar('assinatura adulterada é rejeitada', rSig.valido === false);

// Assinado por outra chave (chave privada trocada, chave pública do site igual).
const outro = await gerarParDeChaves();
const tokenIntruso = await emitirToken(dados, await importarChavePrivada(outro.privadaJwk, true), kid);
const rIntruso = await verificarToken(tokenIntruso, chaves);
checar('assinatura de chave estranha é rejeitada', rIntruso.valido === false);

// kid desconhecido.
const rKid = await verificarToken(await emitirToken(dados, chavePrivada, 'inexistente'), chaves);
checar('kid desconhecido é rejeitado', rKid.valido === false);

// Entradas malformadas não devem lançar exceção.
for (const lixo of ['', '   ', 'abc', 'a.b', 'x.y.z', '...', 'AAAA.BBBB', '#$%.&*(']) {
  try {
    const rl = await verificarToken(lixo, chaves);
    checar(`entrada inválida ${JSON.stringify(lixo)} tratada`, rl.valido === false && !!rl.erro);
  } catch (e) {
    falhas.push(`entrada inválida ${JSON.stringify(lixo)} lançou exceção: ${e.message}`);
  }
}

// Campo obrigatório ausente.
try {
  await emitirToken({ ...dados, pac: '' }, chavePrivada, kid);
  falhas.push('emissão sem paciente deveria falhar');
} catch {
  ok++;
}

// Campo acima do limite de tamanho.
try {
  await emitirToken({ ...dados, pac: 'X'.repeat(60) }, chavePrivada, kid);
  falhas.push('emissão com paciente acima do limite deveria falhar');
} catch {
  ok++;
}

// --- Rotação de chaves ---------------------------------------------------

const kidNovo = '2026-09';
const par2 = await gerarParDeChaves();
const chavesAmbas = {
  [kid]: { chave: chavePublica, entidade: 'AFABANES' },
  [kidNovo]: { chave: await importarChavePublica(par2.publicaJwk), entidade: 'AFABANES' },
};
const tokenNovo = await emitirToken(dados, await importarChavePrivada(par2.privadaJwk, true), kidNovo);
checar('token da chave nova valida', (await verificarToken(tokenNovo, chavesAmbas)).valido);
checar('token da chave antiga continua valendo', (await verificarToken(token, chavesAmbas)).valido);

// --- Índice de chaves curtas ---------------------------------------------

// Formato da chave.
checar('chave sorteada tem 16 dígitos', /^\d{16}$/.test(gerarChave()));
checar('formatação em grupos de 4',
  formatarChave('1234567890123456') === '1234-5678-9012-3456');
checar('normalização aceita hífens', normalizarChave('1234-5678-9012-3456') === '1234567890123456');
checar('normalização aceita espaços', normalizarChave(' 1234 5678 9012 3456 ') === '1234567890123456');
checar('chave incompleta é reconhecida', !chaveCompleta('12345678'));
checar('chave completa é reconhecida', chaveCompleta('1234-5678-9012-3456'));

// Dígitos sorteados devem cobrir 0..9 sem viés grosseiro.
const contagem = new Array(10).fill(0);
for (let i = 0; i < 400; i++) for (const d of gerarChave()) contagem[Number(d)]++;
checar('dígitos cobrem 0..9', contagem.every((c) => c > 0), JSON.stringify(contagem));
checar('sem viés grosseiro entre dígitos',
  Math.max(...contagem) / Math.min(...contagem) < 1.5, JSON.stringify(contagem));

// Duas chaves seguidas não podem coincidir.
checar('chaves sorteadas são distintas', gerarChave() !== gerarChave());

// Ida e volta pelo índice.
const indice = indiceVazio();
const chaveCurta = gerarChave();
const reg = await criarRegistro(chaveCurta, token, indice.kdf);
indice.registros[reg.id] = reg.valor;

checar('registro abre com a chave certa', (await abrirRegistro(chaveCurta, indice)) === token);
checar('registro abre com a chave formatada',
  (await abrirRegistro(formatarChave(chaveCurta), indice)) === token);
checar('chave errada não abre', (await abrirRegistro(gerarChave(), indice)) === null);

// O token que sai do índice ainda precisa passar pela conferência de assinatura.
const doIndice = await abrirRegistro(chaveCurta, indice);
checar('token vindo do índice valida', (await verificarToken(doIndice, chaves)).valido);

// Nada legível pode sobrar no arquivo publicado.
const publicado = JSON.stringify(indice);
checar('índice não vaza o paciente', !publicado.includes('MARIA'));
checar('índice não vaza o médico', !publicado.includes('JOANA'));
checar('índice não guarda a chave em claro', !publicado.includes(chaveCurta));
checar('identificador não é a chave', reg.id !== chaveCurta && !reg.id.includes(chaveCurta));

// Registro adulterado: o AES-GCM é autenticado, então a abertura tem que falhar.
const bytesReg = Buffer.from(indice.registros[reg.id], 'base64url');
bytesReg[30] ^= 0xff;
const indiceAdulterado = {
  kdf: indice.kdf,
  registros: { [reg.id]: bytesReg.toString('base64url') },
};
checar('registro adulterado não abre', (await abrirRegistro(chaveCurta, indiceAdulterado)) === null);

// Sal diferente tem que produzir identificador diferente para a mesma chave.
const outroIndice = indiceVazio();
const regOutroSal = await criarRegistro(chaveCurta, token, outroIndice.kdf);
checar('sal diferente muda o identificador', regOutroSal.id !== reg.id);

// --- Tamanho e QR --------------------------------------------------------

// O QR agora carrega só a URL e os 16 dígitos — o tamanho não depende mais do
// comprimento dos nomes, então não existe "pior caso" variável.
const url = `https://exemplo.github.io/validar-atestado/#${formatarChave(chaveCurta)}`;
const qr = encodeQR(url, { ecLevel: 'M' });
checar('QR pequeno o bastante para imprimir', qr.version <= 6, `versão ${qr.version}`);

console.log(`Chave: ${formatarChave(chaveCurta)}  (${url.length} caracteres na URL)`);
console.log(`QR: versão ${qr.version} (${qr.size}x${qr.size} módulos), nível M`);
console.log(`Token assinado (guardado cifrado no índice): ${token.length} caracteres`);
console.log('');

// --- HTML e JS não podem sair de sincronia -------------------------------

// A página é editada à mão com frequência (inclusive pela interface do GitHub).
// Um elemento removido do HTML não pode derrubar o script: foi exatamente assim
// que a leitura do QR Code parou de funcionar uma vez, porque o listener de um
// botão retirado lançava TypeError antes da linha que lê o fragmento da URL.
{
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(resolve(raiz, 'docs/index.html'), 'utf8');
  const js = await fs.readFile(resolve(raiz, 'docs/validar.js'), 'utf8');

  const idsNoHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const obrigatorios = (js.match(/const OBRIGATORIOS = \[([\s\S]*?)\]/)?.[1] ?? '')
    .match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];

  checar('lista de obrigatórios foi encontrada no script', obrigatorios.length > 0);
  const faltando = obrigatorios.filter((id) => !idsNoHtml.has(id));
  checar('todo elemento obrigatório existe no HTML', faltando.length === 0, faltando.join(', '));

  // Acesso direto (`$('x').`) só é permitido para elementos obrigatórios; o
  // resto tem que passar pelos ajudantes tolerantes ou por checagem explícita.
  const acessoDireto = [...js.matchAll(/\$\('([^']+)'\)\s*\.(?!\s*\?)/g)].map((m) => m[1]);
  const desprotegidos = [...new Set(acessoDireto)].filter((id) => !obrigatorios.includes(id));
  checar('nenhum elemento opcional é acessado sem proteção',
    desprotegidos.length === 0, desprotegidos.join(', '));
}

// --- Chaves públicas publicadas não contêm material privado --------------

try {
  const publicadas = JSON.parse(
    await (await import('node:fs/promises')).readFile(resolve(raiz, 'docs/chaves-publicas.json'), 'utf8')
  );
  const temPrivado = JSON.stringify(publicadas).includes('"d"');
  checar('chaves-publicas.json não contém a componente privada', !temPrivado);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.log('(docs/chaves-publicas.json ainda não existe — rode tools/gerar-chaves.mjs)');
}

// --- Resultado -----------------------------------------------------------

console.log(`${ok} verificações ok, ${falhas.length} falhas`);
for (const f of falhas) console.log('  x ' + f);
process.exit(falhas.length === 0 ? 0 : 1);
