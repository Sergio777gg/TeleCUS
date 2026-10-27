---
title: "TeleCUS - Confirmación en Calendar, Meet y notificaciones"
category: "calendar_and_notifications"
audience: ["patient", "admin", "doctor", "system"]
status: "current_implementation"
version: "2026-09-20"
priority: 100
---

# Condición para crear la cita confirmada

La creación de la cita definitiva en Google Calendar ocurre **después de que el pago ha sido verificado**.

Una pre-reserva pendiente de pago no debe presentarse al paciente como una cita definitivamente confirmada.

# Google Calendar

Al confirmarse el pago, el servicio de agendamiento debe:

1. crear o confirmar el evento correspondiente en Google Calendar;
2. registrar la fecha y hora de inicio;
3. mantener una duración de 30 minutos;
4. asociar al médico asignado;
5. conservar el identificador del evento para posteriores consultas, reprogramaciones o cancelaciones.

# Invitados

El evento confirmado debe incluir como invitados:
- al paciente;
- al médico asignado.

El paciente y el médico deben recibir acceso únicamente a la información necesaria para esa cita.

# Google Meet

Para una cita confirmada se debe generar un enlace de Google Meet o el mecanismo institucional de videollamada que se configure en el futuro.

El enlace debe quedar asociado a la cita confirmada.

# Correo de confirmación

Después de que la operación de Calendar sea exitosa, se envía al paciente un correo con la información relevante de su cita, como:
- fecha;
- hora;
- duración;
- confirmación de la reserva;
- enlace de videollamada cuando corresponda;
- instrucciones administrativas configuradas.

Nunca se debe enviar un correo afirmando que la cita está confirmada si la creación o actualización del evento falló.

# Médico

El médico asignado debe poder ver la cita en su calendario y disponer del enlace de videollamada.

El sistema puede proporcionar además una vista de “Mis citas” para el médico, pero la agenda real debe sincronizarse con Calendar.

# Información dinámica

El enlace de Meet, el identificador del evento y los invitados de una cita concreta deben consultarse en las herramientas del sistema. El RAG no debe inventarlos ni almacenarlos como hechos estáticos.
