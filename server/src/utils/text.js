// Normalização de texto compartilhada (nicho, cidade, nome de negócio):
// minúsculas + remove acentuação. Antes duplicada em osmProvider.js e
// geocode.js com pequenas diferenças (uma tinha `?? ''`, a outra `.trim()`);
// unificada aqui com as duas garantias.
export const normalize = (s) => (s ?? '')
  .toString()
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .trim();
