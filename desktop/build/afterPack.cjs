// Hook afterPack do electron-builder. Sem certificado Apple Developer pago,
// o build sai sem assinatura (CSC_IDENTITY_AUTO_DISCOVERY=false no CI). No
// macOS isso NÃO significa "sem assinatura nenhuma": o binário do Electron já
// sai do linker com uma assinatura ad-hoc parcial (só cobre o executável), e
// ela fica inválida assim que o electron-builder copia os arquivos extras
// (server/src, web/dist — asar:false) pro bundle. Resultado: o Gatekeeper
// detecta uma assinatura CORROMPIDA (`spctl -a` acusa "code has no resources
// but signature indicates they must be present") e mostra "app está
// danificado, mova pro Lixo" — um diálogo bem mais grave que o aviso normal
// de "desenvolvedor não identificado", e que o aluno não consegue contornar
// (nem com botão direito > Abrir, nem com `xattr -cr`).
//
// Reassinar ad-hoc (sem `--options runtime`, senão o hardened runtime exige
// entitlements de JIT que não configuramos e o Electron trava no boot) cobrindo
// o bundle inteiro corrige o selo e devolve o comportamento pro Gatekeeper
// padrão — aí sim o botão direito > Abrir / `xattr -cr` já documentados no
// guia de instalação resolvem. NÃO substitui assinatura Developer ID +
// notarização (só isso remove o aviso de "desenvolvedor não identificado" de
// vez); ver docs/instalar-app.md.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
