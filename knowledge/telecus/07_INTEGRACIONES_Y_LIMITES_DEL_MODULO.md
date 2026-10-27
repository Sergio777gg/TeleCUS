---
title: "TeleCUS - Integraciones y límites del módulo de agendamiento"
category: "architecture"
audience: ["system", "admin"]
status: "current_design"
version: "2026-09-20"
priority: 90
---

# Alcance del módulo

El sistema desarrollado corresponde al **módulo de agendamiento**.

No busca implementar todo el proceso de telemedicina descrito en el flujo institucional.

Quedan fuera del alcance actual:
- procesamiento bancario o PSE;
- facturación institucional completa;
- historia clínica;
- consulta médica;
- diagnósticos;
- tratamientos;
- fórmulas;
- remisiones;
- incapacidades;
- gestión documental clínica.

# Integraciones actuales

El módulo puede integrarse con:
- Google Calendar para agenda;
- Google Meet para videollamada;
- Gmail o correo institucional para notificaciones;
- un sistema de autenticación para identificar usuarios;
- una base de datos para usuarios, roles, pre-reservas, citas y estados.

# Integraciones futuras

El diseño debe permitir integrar servicios externos mediante API o webhook, en particular:
- PSE o sistema de pagos;
- facturación;
- otros módulos institucionales;
- una agenda distinta a Google Calendar si el CUS cambia de plataforma.

# Regla de desacoplamiento

El chatbot no debe depender directamente de los detalles internos de un proveedor externo.

Ejemplo: el chatbot no necesita saber cómo funciona PSE. Solo necesita recibir el estado administrativo del pago desde el servicio correspondiente.

# Fuente de verdad

La base de datos del módulo debe conservar el estado administrativo de la reserva.

Google Calendar representa la agenda confirmada, pero no debe utilizarse como única fuente para:
- estado de pago;
- permisos;
- propietario de la cita;
- rol del usuario;
- estado de pre-reserva.

# Estados mínimos sugeridos

Estado de cita:
- `PRE_RESERVED`
- `CONFIRMED`
- `RESCHEDULED`
- `CANCELLED`

Estado de pago:
- `PENDING`
- `VERIFIED`

Estos nombres son una convención técnica del prototipo y pueden ampliarse sin cambiar el flujo general.

# Contrato futuro de pago

Una integración externa de pago debería ser capaz de informar:
- identificador de la reserva;
- estado del pago;
- referencia de pago cuando exista.

No se incluye en el RAG ninguna URL real, token, secreto o credencial de integración.
