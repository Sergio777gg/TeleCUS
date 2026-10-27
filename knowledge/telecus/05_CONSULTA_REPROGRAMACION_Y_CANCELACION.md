---
title: "TeleCUS - Consultar, reprogramar y cancelar citas"
category: "appointment_management"
audience: ["patient", "admin", "doctor"]
status: "current_implementation"
version: "2026-09-20"
priority: 95
---

# Consulta de citas

Un paciente autenticado puede consultar sus propias pre-reservas y citas.

La búsqueda debe realizarse en la base de datos o herramientas del sistema utilizando la identidad autenticada. El chatbot nunca debe usar el RAG para determinar qué citas tiene una persona.

# Privacidad

El paciente solo puede acceder a sus propios registros.

No se debe permitir:
- listar citas de otros pacientes;
- consultar datos personales de terceros;
- modificar o cancelar citas ajenas.

Esta restricción debe aplicarse técnicamente en el backend, no solo mediante instrucciones al modelo de lenguaje.

# Reprogramación

El sistema puede permitir reprogramar una cita o pre-reserva cuando:
- el usuario está autorizado sobre esa cita;
- existe disponibilidad en el nuevo horario;
- el usuario confirma el cambio.

Para una cita ya confirmada en Google Calendar, la reprogramación debe actualizar el evento existente mediante su identificador. No debe crear una segunda cita como sustituto.

La duración se mantiene en 30 minutos.

La política exacta sobre pagos asociados a una reprogramación no está completamente definida en la documentación vigente. El chatbot no debe inventar cobros, devoluciones, plazos ni exenciones.

# Cancelación

Antes de cancelar:
1. identificar de forma segura la cita;
2. mostrar al usuario la cita que se cancelará;
3. solicitar confirmación explícita;
4. ejecutar la cancelación únicamente después de confirmar.

# Reembolsos

El material del proyecto contiene referencias no completamente armonizadas sobre pagos y reembolsos. Por ello, el chatbot no debe afirmar una política definitiva de devolución hasta que exista una regla institucional aprobada y configurada.

# Administrativo

El rol administrativo puede gestionar las citas dentro del alcance de agendamiento y puede intervenir cuando se requiera resolver inconsistencias, validar pagos o apoyar una reprogramación.

# Médico

El médico solo debe consultar las citas que le han sido asignadas. No necesita permisos para acceder a la agenda completa de otros médicos.
