#!/usr/bin/env node
// Testes unitários da lógica de busca — SEM bater em rede real (Overpass,
// Nominatim). Overpass é um serviço público gratuito e limitado por IP
// (comentário em osmProvider.js); um teste que faz requests reais a cada
// `npm test`/CI é abuso do serviço e fica refém de dado externo mutável.
// Testamos as funções puras extraídas exatamente pra isso ser possível.
//
//   node server/test/search.test.mjs

import assert from 'node:assert/strict';
import { buildQuery, elementsOuErro } from '../src/data/osmProvider.js';
import { ufDoEstado } from '../src/data/geocode.js';

let passed = 0;
function check(desc, fn) {
  fn();
  passed++;
  console.log(`✓ ${desc}`);
}

// ── buildQuery: nw (não nwr) + timeout/limite adaptativo por raio ──────────
check('buildQuery usa nw (não nwr) pra tags conhecidas', () => {
  const q = buildQuery({ tags: ['office=lawyer'], niche: 'advocacia', lat: -23.5, lng: -46.6, radiusKm: 5 });
  assert.match(q, /nw\["office"="lawyer"\]/);
  assert.doesNotMatch(q, /nwr\[/);
});

check('buildQuery usa nw pra busca por nome (nicho desconhecido)', () => {
  const q = buildQuery({ tags: [], niche: 'pilates', lat: -23.5, lng: -46.6, radiusKm: 5 });
  assert.match(q, /nw\["name"~"pilates",i\]/);
});

check('buildQuery: raio <= 15km usa timeout 25s e limite 150', () => {
  const q = buildQuery({ tags: ['shop=bakery'], niche: 'padaria', lat: -23.5, lng: -46.6, radiusKm: 15 });
  assert.match(q, /\[timeout:25\]/);
  assert.match(q, /out center 150;/);
});

check('buildQuery: raio > 15km usa timeout 40s e limite 200', () => {
  const q = buildQuery({ tags: ['shop=bakery'], niche: 'padaria', lat: -23.5, lng: -46.6, radiusKm: 30 });
  assert.match(q, /\[timeout:40\]/);
  assert.match(q, /out center 200;/);
});

// ── elementsOuErro: detecta erro de runtime mascarado em resposta 200 OK ───
check('elementsOuErro devolve elements normalmente quando não há erro', () => {
  const elements = elementsOuErro({ elements: [{ type: 'node', id: 1 }] });
  assert.equal(elements.length, 1);
});

check('elementsOuErro lança quando o Overpass embute um runtime error no JSON', () => {
  assert.throws(
    () => elementsOuErro({ remark: 'runtime error: Query timed out in "query" at line 1.', elements: [] }),
    /Overpass runtime error/
  );
});

check('elementsOuErro NÃO lança pra remarks que não são erro de runtime', () => {
  const elements = elementsOuErro({ remark: 'some informational note', elements: [{ type: 'node', id: 1 }] });
  assert.equal(elements.length, 1);
});

check('elementsOuErro devolve array vazio quando elements falta de vez (sem remark)', () => {
  assert.deepEqual(elementsOuErro({}), []);
});

// ── ufDoEstado: whitelist real de 27 UFs, não regex solto ──────────────────
check('ufDoEstado resolve nome de estado (com acento) pra sigla', () => {
  assert.equal(ufDoEstado('Paraná'), 'PR');
  assert.equal(ufDoEstado('São Paulo'), 'SP');
  assert.equal(ufDoEstado('Rio Grande do Sul'), 'RS');
});

check('ufDoEstado é case-insensitive', () => {
  assert.equal(ufDoEstado('paraná'), 'PR');
  assert.equal(ufDoEstado('PARANÁ'), 'PR');
});

check('ufDoEstado devolve null pra texto que não é um estado brasileiro', () => {
  assert.equal(ufDoEstado('Nárnia'), null);
  assert.equal(ufDoEstado('XX'), null);
  assert.equal(ufDoEstado(''), null);
  assert.equal(ufDoEstado(undefined), null);
});

console.log(`\n${passed} teste(s) passou/passaram.`);
