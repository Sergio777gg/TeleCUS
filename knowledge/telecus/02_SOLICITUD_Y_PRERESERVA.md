---
title: "TeleCUS - Solicitud de cita y pre-reserva"
category: "scheduling"
audience: ["patient", "admin"]
status: "current_implementation"
version: "2026-09-20"
priority: 100
---

# Inicio del proceso

El paciente inicia sesión en la plataforma y accede al chatbot de TeleCUS.

La autenticación permite identificar al usuario y evita solicitar repetidamente información que ya está disponible en su perfil, como nombre y correo electrónico.

# Datos necesarios para el agendamiento

Para el prototipo actual, el chatbot utiliza únicamente los datos necesarios para gestionar la cita:

- identidad del usuario autenticado;
- correo asociado o confirmado;
- fecha y hora solicitadas;
- motivo general de la solicitud.

No se debe solicitar información clínica detallada ni datos sensibles que no sean necesarios para el agendamiento.

La guía institucional de atención contiene una lista más amplia de datos administrativos y clínicos, pero está marcada como **borrador pendiente de validación médica, jurídica, tecnológica y administrativa**. Por ello, esos datos adicionales no se convierten automáticamente en requisitos obligatorios del chatbot actual.

# Validación del horario

Antes de ofrecer una pre-reserva, el sistema debe:

1. verificar que la fecha solicitada corresponda a una jornada habilitada;
2. consultar la disponibilidad real;
3. comprobar que el espacio permita una cita de 30 minutos;
4. informar al usuario el horario disponible.

# Pre-reserva

Cuando el paciente acepta un horario disponible se crea una **pre-reserva**, no una cita definitivamente confirmada.

La pre-reserva representa la separación temporal de un cupo mientras se completa el proceso administrativo de pago.

Estados recomendados para esta etapa:
- `PRE_RESERVED`
- `PAYMENT_PENDING`

# Confirmación del usuario

Antes de crear una pre-reserva, el chatbot debe resumir:
- fecha;
- hora;
- duración;
- motivo general;
- condición de pago pendiente.

El usuario debe confirmar explícitamente que desea continuar.

# Si no hay disponibilidad

Si el horario solicitado no está disponible:
- no se crea la pre-reserva;
- se informa al usuario;
- se solicita otra fecha u hora válida o se ofrecen opciones obtenidas del sistema.

El chatbot no debe inventar cupos.
