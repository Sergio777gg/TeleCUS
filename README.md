# TeleCUS

TeleCUS apoya el agendamiento de teleconsultas del Centro Universitario de Salud de la Universidad del Cauca. Re�ne una interfaz para pacientes, m�dicos y administraci�n, con reglas de negocio y autorizaci�n centralizadas en el backend.

## Funciones principales

- **Paciente:** consultar citas, solicitar una pre-reserva y cambios, adjuntar comprobantes y documentos previos, y revisar notificaciones.
- **Administraci�n:** gestionar agenda, solicitudes, perfiles, pagos, horarios y conocimiento del servicio.
- **M�dico:** consultar su agenda y gestionar las atenciones asignadas.
- **Asistente:** interpretar solicitudes y ofrecer orientaci�n con fuentes recuperadas. Las autorizaciones y las operaciones sobre citas se resuelven en c�digo y base de datos.

## Tecnolog�as

Frontend React y Vite; backend NestJS y TypeScript; PostgreSQL/Supabase para la operaci�n integrada y SQLite para trabajos, sesiones y simulaci�n. La inferencia local utiliza Node-RED y Ollama con el perfil `telecus-local`, derivado de `qwen3.5:4b`.

## Inicio r�pido en Windows

Requisitos: **Node.js >=22.13.0**, npm, Git y Ollama instalado y en ejecuci�n. Se necesita una cuenta con acceso a este repositorio privado.

Ejecuta en PowerShell:

```powershell
git clone https://github.com/Sergio777gg/TeleCUS.git
cd TeleCUS
npm ci

npm install -g node-red@4.1.10
ollama pull qwen3.5:4b
ollama create telecus-local -f models/Telecus.Modelfile

npm run build
.\INICIAR_PRUEBA_LOCAL.cmd
```

Abre **http://localhost:5173/** y selecciona uno de los tres perfiles ficticios. La demo permite practicar con citas y archivos de prueba; el pago externo est� deshabilitado.

El primer arranque prepara la configuraci�n privada y las carpetas locales. Puertos predeterminados: aplicaci�n **5173**, Node-RED **1880** y Ollama **11434**. Si Node-RED est� instalado en otra ubicaci�n, define `NODE_RED_ENTRY` con la ruta real a su archivo `red.js` antes de iniciar.

Para comprobar el arranque:

```powershell
Invoke-RestMethod http://127.0.0.1:5173/api/healthz
```

En demo se espera `status=ok`, `mode=demo` y `database=sqlite`. El indicador `inference` informa la disponibilidad del servicio interno; la salud b�sica no acredita las integraciones externas.

Para detener TeleCUS:

```powershell
npm stop
```

Conserva los archivos `.cmd` de la ra�z junto con `launchers/windows/`: los primeros delegan el arranque en los segundos.

## Pruebas

```powershell
npm test
npm run check:architecture
```

La revisi�n local del **27 de octubre de 2026** registr� **242 pruebas autom�ticas aprobadas y cero fallos**, adem�s de comprobaciones de interfaz en demo. Esto no equivale a validar OAuth institucional, Supabase o Google reales ni a ejecutar todos los casos de aceptaci�n.

`npm run check:layout` comprueba tambi�n archivos de la documentaci�n completa, excluidos de este repositorio. Puede se�alar esas ausencias en este clon y no es un requisito de arranque.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `apps/frontend/` | Interfaz web |
| `apps/backend/` | API, servicios, permisos y adaptadores |
| `node-red/` | Flujos y configuraci�n de inferencia |
| `models/` | Definici�n del perfil local de Ollama |
| `knowledge/` | Corpus funcional de orientaci�n |
| `scripts/` | Configuraci�n, arranque, comprobaciones y migraciones SQL |
| `launchers/windows/` | Accesos de ejecuci�n para Windows |
| `deploy/` | Plantillas de configuraci�n del destino |
| `tests/` | Pruebas automatizadas |

## Conexi�n institucional

La operaci�n real requiere configuraci�n propia de Supabase y Google, perfiles autorizados, calendario y claves del destino. Las plantillas est�n en `deploy/env/`. Las migraciones son aditivas: se debe obtener la l�nea base del esquema p�blico de Supabase para preparar una instalaci�n integrada nueva.

Los documentos y comprobantes se almacenan cifrados en disco privado, con sus metadatos en la base de datos. Su recuperaci�n requiere un respaldo coherente de metadatos, archivos y clave de cifrado.

## Documentaci�n y archivos privados

La arquitectura, el Excel de requisitos y casos, el manual de instalaci�n y el informe Word de pruebas se entregan por separado en la carpeta de documentaci�n. Las capturas y los registros de evidencias permanecen all�.

Este repositorio excluye credenciales, configuraci�n privada, datos, registros, dependencias instaladas, compilados, documentaci�n formal, capturas y vistas. Conserva el README y el corpus de conocimiento como recursos versionados. No publiques `.env`, `ACCESO_NODE_RED.local.txt`, `data/` ni `logs/`.

## Criterios de teleconsulta y pruebas de seguridad

El cat�logo ofrece valoraci�n sin examen f�sico, revisi�n de laboratorios, control seg�n criterio m�dico, remisiones/�rdenes y f�rmulas. El men� muestra las opciones de atenci�n presencial prioritaria y urgencias, sin el bloque extenso de criterios cl�nicos. Seleccionar una de esas rutas por bot�n, nombre o n�mero detiene el agendamiento y descarta propuestas pendientes; no cancela citas existentes. Es una selecci�n declarada por el usuario, no un diagn�stico ni detecci�n exhaustiva de s�ntomas en texto libre.

Antes de activar estos tipos en Supabase, aplicar `scripts/sql/017-consultation-criteria.sql` despu�s de 016 y realizar una prueba de integraci�n. Conserva tipos hist�ricos y el envoltorio de permisos y motivos de rechazo de 015. La migraci�n no se ha ejecutado contra una base real durante estas pruebas. Reiniciar el backend y cargar el flujo actualizado `node-red/flows.json` mediante el procedimiento habitual.

- `npm run test:security`: pruebas sint�ticas de permisos, aislamiento entre usuarios, confirmaciones, validaci�n, l�mites, CORS, archivos y RAG. Los casos adversarios del int�rprete simulan deliberadamente respuestas de un modelo comprometido.
- `npm run test:prompt-injection:local -- tests/security-evidence/local-model.json`: requiere Ollama local y el modelo `telecus-local`. Ejecuta inferencia real con las funciones generadas de Node-RED en una VM; no prueba un servidor Node-RED desplegado ni usa datos o integraciones reales.
- `npm audit --audit-level=moderate`: consulta las alertas de dependencias; no representa un pentest.

La metodolog�a se basa en [OWASP WSTG](https://owasp.org/www-project-web-security-testing-guide/) y la [gu�a OWASP de prevenci�n de prompt injection](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html). No es una certificaci�n OWASP ni garantiza inmunidad a inyecciones. El informe JSON distingue salidas crudas privilegiadas del modelo y resultados despu�s del filtro del int�rprete. El backend conserva las comprobaciones de permisos y la confirmaci�n expl�cita aunque el modelo falle. Las citas de fuentes validan procedencia, no la veracidad ni la seguridad sem�ntica de toda respuesta RAG.

## Prueba Linux de solo lectura

`supabase-readonly` ejecuta cada llamada de agenda en una transacci�n PostgreSQL `READ ONLY`, tambi�n cuando el pooler ignora las opciones iniciales de conexi�n. Una funci�n que intente escribir se bloquea: algunas consultas hist�ricas con limpieza autom�tica pueden quedar indisponibles en esta prueba. No se modifican los permisos ni la configuraci�n global de Supabase, y el modo operativo conserva su comportamiento.

La instalaci�n de usuario de `deploy/linux-user/` espera esta distribuci�n en `~/telecus-fiet/`: repositorio en `TeleCUS/`, Node 24 en `node24/bin/node`, Cloudflared en `bin/cloudflared`, Ollama en `ollama/bin/ollama`, Node-RED 4.1.10 en `node-red-runtime/node_modules/node-red/red.js` y el modelo `telecus-local` ya creado. Estos componentes son requisitos previos; el instalador de servicios no los descarga.

La configuraci�n privada est� fuera del repositorio: `api.env`, `node-red.env`, `supabase-ca.crt` y el estado en `state/`, con acceso exclusivo del usuario. Definir `DATA_MODE=supabase-readonly`, `RUN_DELIVERY_WORKER=false`, rutas absolutas y el mismo `TELECUS_INTERNAL_TOKEN` en ambos archivos. Node-RED debe escuchar en `127.0.0.1` y tener `NODE_RED_DISABLE_EDITOR=true`. No transferir tokens de Google ni datos cl�nicos a esta prueba.

```bash
export PATH="$HOME/telecus-fiet/node24/bin:$PATH"
cd ~/telecus-fiet/TeleCUS
npm ci
npm run build
node --env-file=../api.env scripts/check-agenda-readonly.cjs
bash deploy/linux-user/install-services.sh
curl --fail http://127.0.0.1:5173/api/healthz
systemctl --user start telecus-tunnel.service
journalctl --user -u telecus-tunnel.service --no-pager -n 30
```

Tomar la URL HTTPS de ese t�nel y establecerla como origen exacto:

```bash
node deploy/linux-user/set-origin.cjs https://REEMPLAZAR.trycloudflare.com
systemctl --user restart telecus-app.service
```

Los t�neles r�pidos cambian de nombre cuando se recrean. Actualizar entonces el origen de la API y, si se usa OAuth, la lista de retornos autorizados en Supabase. No usar comodines. Los servicios de usuario requieren una sesi�n activa; para arrancar antes de iniciar sesi�n, el administrador debe habilitar `loginctl enable-linger USUARIO`. No se necesita exponer los puertos locales en el router.
