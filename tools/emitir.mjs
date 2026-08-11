// Emite um atestado pela linha de comando: assina, sorteia a chave de 16
// dígitos, cifra o registro e grava em docs/atestados.json.
//
//   node tools/emitir.mjs "NOME DO PACIENTE" "NOME DO MÉDICO" [AAAA-MM-DD]
//
// Sem argumentos, emite um exemplo com dados fictícios.
//
// Depois de emitir, docs/atestados.json precisa ir para o repositório — é o
// arquivo que a página de validação consulta.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { criarRegistro, formatarChave, gerarChave, indiceVazio } from '../docs/lib/indice.js';
import { emitirToken, importarChavePrivada } from '../docs/lib/token.js';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pastaPrivadas = resolve(raiz, 'chaves-privadas');
const arquivoIndice = resolve(raiz, 'docs/atestados.json');

// --- Chave privada -------------------------------------------------------

let arquivos;
try {
  arquivos = (await readdir(pastaPrivadas)).filter((f) => f.endsWith('.json')).sort();
} catch {
  console.error('Pasta chaves-privadas/ não encontrada. Rode antes: node tools/gerar-chaves.mjs');
  process.exit(1);
}
if (arquivos.length === 0) {
  console.error('Nenhuma chave privada encontrada. Rode antes: node tools/gerar-chaves.mjs');
  process.exit(1);
}

// A mais recente, já que o nome do arquivo é o kid (AAAA-MM).
const { kid, jwk } = JSON.parse(await readFile(resolve(pastaPrivadas, arquivos.at(-1)), 'utf8'));
const chavePrivada = await importarChavePrivada(jwk, true);

// --- Índice --------------------------------------------------------------

let indice;
try {
  indice = JSON.parse(await readFile(arquivoIndice, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  indice = indiceVazio();
  console.log('docs/atestados.json não existia; criando com sal novo.');
}

// --- Emissão -------------------------------------------------------------

const [paciente, medico, data] = process.argv.slice(2);
const dados = {
  pac: paciente ?? 'MARIA APARECIDA DA SILVA SANTOS',
  prof: medico ?? 'DRA. JOANA PEREIRA DE ALMEIDA',
  em: data ?? new Date().toISOString().slice(0, 10),
};

const token = await emitirToken(dados, chavePrivada, kid);
const chave = gerarChave();
const { id, valor } = await criarRegistro(chave, token, indice.kdf);

if (indice.registros[id]) {
  console.error('Colisão de identificador — rode de novo (a chance é desprezível).');
  process.exit(1);
}
indice.registros[id] = valor;

await writeFile(arquivoIndice, JSON.stringify(indice, null, 2) + '\n', 'utf8');

// --- Saída ---------------------------------------------------------------

console.log('');
console.log(`  Paciente:         ${dados.pac}`);
console.log(`  Médico:           ${dados.prof}`);
console.log(`  Data da consulta: ${dados.em}`);
console.log('');
console.log('  CHAVE DE VALIDAÇÃO');
console.log(`  ${formatarChave(chave)}`);
console.log('');
console.log(`Registro gravado em docs/atestados.json (${Object.keys(indice.registros).length} no total).`);
console.log('Assinado com a chave privada:', kid);
console.log('');
console.log('Guarde a chave agora: ela não fica em lugar nenhum em texto claro.');
console.log('Sem ela, o registro correspondente não pode mais ser aberto por ninguém.');
