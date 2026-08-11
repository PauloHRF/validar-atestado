// Gera um par de chaves ECDSA P-256 para assinar atestados.
//
//   node tools/gerar-chaves.mjs                             (sem emissor nomeado)
//   node tools/gerar-chaves.mjs "NOME DA ENTIDADE EMISSORA"
//
// Grava a chave PÚBLICA em docs/chaves-publicas.json (vai para o repositório)
// e a chave PRIVADA em chaves-privadas/<kid>.json (fora do repositório).
//
// A chave privada NUNCA pode ser commitada nem sair da máquina do emissor.
// Se ela vazar, qualquer pessoa consegue forjar atestados válidos.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gerarParDeChaves } from '../docs/lib/token.js';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arquivoPublicas = resolve(raiz, 'docs/chaves-publicas.json');
const pastaPrivadas = resolve(raiz, 'chaves-privadas');

async function lerPublicas() {
  try {
    return JSON.parse(await readFile(arquivoPublicas, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function proximoKid(existentes) {
  const agora = new Date();
  const base = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
  if (!existentes[base]) return base;
  for (const sufixo of 'bcdefghijklmnopqrstuvwxyz') {
    if (!existentes[`${base}${sufixo}`]) return `${base}${sufixo}`;
  }
  throw new Error('Chaves demais geradas neste mês.');
}

// A entidade emissora é opcional. Quando informada, fica ligada à chave — e não
// ao documento — de modo que quem preenche o formulário de emissão não consegue
// forjá-la. Quando omitida, a página de validação simplesmente não nomeia
// emissor nenhum: continua afirmando só o que de fato conferiu, ou seja, que a
// assinatura bate e que os dados não foram alterados.
const entidade = (process.argv[2] ?? '').trim();

const publicas = await lerPublicas();
const kid = proximoKid(publicas);
const { privadaJwk, publicaJwk } = await gerarParDeChaves();

publicas[kid] = {
  ...(entidade ? { entidade } : {}),
  criada_em: new Date().toISOString().slice(0, 10),
  jwk: { kty: publicaJwk.kty, crv: publicaJwk.crv, x: publicaJwk.x, y: publicaJwk.y },
};

await writeFile(arquivoPublicas, JSON.stringify(publicas, null, 2) + '\n', 'utf8');

await mkdir(pastaPrivadas, { recursive: true });
const destinoPrivada = resolve(pastaPrivadas, `${kid}.json`);
await writeFile(
  destinoPrivada,
  JSON.stringify({ kid, jwk: privadaJwk }, null, 2) + '\n',
  { encoding: 'utf8', mode: 0o600 }
);

console.log(`Par de chaves gerado. Identificador (kid): ${kid}`);
console.log(`  pública  -> docs/chaves-publicas.json   (commitar)`);
console.log(`  privada  -> chaves-privadas/${kid}.json   (NÃO commitar, guardar em local seguro)`);
console.log('');
console.log('Faça uma cópia de segurança da chave privada agora. Sem ela você não');
console.log('consegue emitir novos atestados com este kid — os já emitidos continuam válidos.');
