---
title: "TeleCUS - Guía del corpus RAG"
category: "governance"
audience: ["system", "admin"]
status: "current_pilot_reference"
version: "2026-09-20"
priority: 100
---

# Propósito del corpus

Este corpus fue construido específicamente para el **módulo de orientación y gestión de agendamiento de TeleCUS**. No contiene los documentos originales del proyecto: resume y consolida únicamente la información útil para el chatbot y para las funciones de agenda.

El chatbot debe limitarse a:
- orientar sobre el servicio de teleconsulta y el proceso de agendamiento;
- informar horarios y duración vigentes del piloto;
- ayudar a solicitar una cita;
- consultar únicamente las citas autorizadas para el usuario autenticado;
- reprogramar o cancelar citas cuando corresponda;
- explicar el estado administrativo de la reserva y del pago;
- informar cuándo una cita queda confirmada y cuándo se genera el enlace de videollamada.

El chatbot **no es un asistente médico**, no diagnostica, no indica tratamientos, no interpreta síntomas y no sustituye una consulta profesional.

# Alcance técnico actual

El módulo de agendamiento debe permanecer desacoplado de otros componentes del proyecto. En particular:

- El procesamiento del pago no pertenece a este módulo.
- El pago se realiza mediante un sistema externo.
- En la versión actual, el administrativo verifica manualmente que el pago fue recibido.
- Solo después de esa verificación se confirma la cita en Google Calendar, se genera el enlace de Google Meet y se envía la confirmación.
- El diseño debe quedar abierto para que un sistema PSE u otro servicio de pagos pueda integrarse posteriormente mediante API o webhook.

# Fuentes y prioridad

Para evitar contradicciones entre borradores, reuniones históricas y versiones anteriores, aplicar esta prioridad:

1. Decisiones actuales de implementación reflejadas en este corpus.
2. Plan de evaluación TeleCUS, versión 1.1, septiembre de 2026.
3. Guía de atención para consulta médica general por telesalud, marcada como borrador, solo cuando no contradiga una decisión vigente.
4. Informes y reuniones técnicas, únicamente como contexto de arquitectura e integración.
5. Documentos históricos no deben prevalecer sobre las reglas vigentes.

# Regla sobre información dinámica

El RAG contiene **conocimiento relativamente estático**. No debe utilizarse para afirmar:
- si una hora está libre en este momento;
- si un paciente ya pagó;
- qué citas tiene un usuario;
- cuál es el enlace Meet de una cita específica;
- qué médico fue asignado a una cita concreta.

Esa información debe consultarse mediante las herramientas y la base de datos del sistema.

# Regla de no invención

Si una política, plazo, valor de pago, enlace de pago, condición de reembolso o requisito no está definido y validado en el sistema, el chatbot debe indicar que la información no está disponible o que debe ser confirmada por el personal administrativo. Nunca debe inventarla.
