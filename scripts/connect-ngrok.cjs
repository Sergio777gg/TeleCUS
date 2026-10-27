// Human-entered secret: no command history, project file or token output.
const {execFileSync} = require('node:child_process');
async function readToken() {
  if (!process.stdin.isTTY) throw Error('Abre launchers/windows/CONECTAR_NGROK.cmd para introducir el token en tu PC.');
  process.stdout.write('Pega tu Authtoken de ngrok y pulsa Enter (no se mostrará): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let token = '';
    const finish = () => {process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');};
    const onData = data => {
      for (const character of data.toString('utf8')) {
        if (character === '\u0003') {finish(); reject(Error('Conexión cancelada.')); return;}
        if (character === '\r' || character === '\n') {finish(); resolve(token); return;}
        if (character === '\u007f' || character === '\b') token = token.slice(0, -1);
        else if (character >= ' ' && character !== '\u001b') token += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function main() {
  let token = await readToken();
  if (token.length < 16 || /\s/.test(token)) throw Error('Pega únicamente el token, sin el comando ni espacios.');
  try {
    execFileSync('ngrok.exe', ['config', 'add-authtoken', token], {windowsHide: true, stdio: 'pipe', timeout: 15000});
    token = '';
    console.log('Cuenta vinculada. El token quedó en la configuración personal de ngrok, fuera del proyecto.');
  } catch {
    token = '';
    throw Error('No se pudo guardar el token. Comprueba que ngrok esté instalado y que copiaste el Authtoken correcto.');
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
