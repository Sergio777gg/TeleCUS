# TeleCUS

TeleCUS apoya el agendamiento de teleconsultas del Centro Universitario de Salud de la Universidad del Cauca. Reúne una interfaz para pacientes, médicos y administración, con reglas de negocio y autorización centralizadas en el backend.

## Funciones principales

- **Paciente:** consultar citas, solicitar una pre-reserva y cambios, adjuntar comprobantes y documentos previos, y revisar notificaciones.
- **Administración:** gestionar agenda, solicitudes, perfiles, pagos, horarios y conocimiento del servicio.
- **Médico:** consultar su agenda y gestionar las atenciones asignadas.
- **Asistente:** interpretar solicitudes y ofrecer orientación con fuentes recuperadas. Las autorizaciones y las operaciones sobre citas se resuelven en código y base de datos.

## Tecnologías

Frontend React y Vite; backend NestJS y TypeScript; PostgreSQL/Supabase para la operación integrada y SQLite para trabajos, sesiones y simulación. La inferencia local utiliza Node-RED y Ollama con el perfil `telecus-local`, derivado de `qwen3.5:4b`.

## Inicio rápido en Windows

Requisitos: **Node.js >=22.13.0**, npm, Git y Ollama instalado y en ejecución. Se necesita una cuenta con acceso a este repositorio privado.

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

Abre **http://localhost:5173/** y selecciona uno de los tres perfiles ficticios. La demo permite practicar con citas y archivos de prueba; el pago externo está deshabilitado.

El primer arranque prepara la configuración privada y las carpetas locales. Puertos predeterminados: aplicación **5173**, Node-RED **1880** y Ollama **11434**. Si Node-RED está instalado en otra ubicación, define `NODE_RED_ENTRY` con la ruta real a su archivo `red.js` antes de iniciar.

Para comprobar el arranque:

```powershell
Invoke-RestMethod http://127.0.0.1:5173/api/healthz
```

En demo se espera `status=ok`, `mode=demo` y `database=sqlite`. El indicador `inference` informa la disponibilidad del servicio interno; la salud básica no acredita las integraciones externas.

Para detener TeleCUS:

```powershell
npm stop
```

Conserva los archivos `.cmd` de la raíz junto con `launchers/windows/`: los primeros delegan el arranque en los segundos.

## Pruebas

```powershell
npm test
npm run check:architecture
```

La revisión local del **27 de octubre de 2026** registró **242 pruebas automáticas aprobadas y cero fallos**, además de comprobaciones de interfaz en demo. Esto no equivale a validar OAuth institucional, Supabase o Google reales ni a ejecutar todos los casos de aceptación.

`npm run check:layout` comprueba también archivos de la documentación completa, excluidos de este repositorio. Puede señalar esas ausencias en este clon y no es un requisito de arranque.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `apps/frontend/` | Interfaz web |
| `apps/backend/` | API, servicios, permisos y adaptadores |
| `node-red/` | Flujos y configuración de inferencia |
| `models/` | Definición del perfil local de Ollama |
| `knowledge/` | Corpus funcional de orientación |
| `scripts/` | Configuración, arranque, comprobaciones y migraciones SQL |
| `launchers/windows/` | Accesos de ejecución para Windows |
| `deploy/` | Plantillas de configuración del destino |
| `tests/` | Pruebas automatizadas |

## Conexión institucional

La operación real requiere configuración propia de Supabase y Google, perfiles autorizados, calendario y claves del destino. Las plantillas están en `deploy/env/`. Las migraciones son aditivas: se debe obtener la línea base del esquema público de Supabase para preparar una instalación integrada nueva.

Los documentos y comprobantes se almacenan cifrados en disco privado, con sus metadatos en la base de datos. Su recuperación requiere un respaldo coherente de metadatos, archivos y clave de cifrado.

## Documentación y archivos privados

La arquitectura, el Excel de requisitos y casos, el manual de instalación y el informe Word de pruebas se entregan por separado en la carpeta de documentación. Las capturas y los registros de evidencias permanecen allí.

Este repositorio excluye credenciales, configuración privada, datos, registros, dependencias instaladas, compilados, documentación formal, capturas y vistas. Conserva el README y el corpus de conocimiento como recursos versionados. No publiques `.env`, `ACCESO_NODE_RED.local.txt`, `data/` ni `logs/`.
