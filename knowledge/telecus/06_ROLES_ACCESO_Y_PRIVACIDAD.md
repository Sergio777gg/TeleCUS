---
title: "TeleCUS - Roles, permisos y privacidad"
category: "access_control"
audience: ["system", "admin", "doctor", "patient"]
status: "current_design"
version: "2026-09-20"
priority: 100
---

# Autenticación

La plataforma debe identificar al usuario antes de habilitar funciones relacionadas con citas.

La opción propuesta para el prototipo es **inicio de sesión con Google**, de manera que el sistema pueda asociar la sesión con un usuario y un rol.

# Roles actuales del módulo

## Paciente

Puede:
- conversar con el chatbot;
- solicitar una pre-reserva;
- consultar sus propias citas;
- consultar el estado administrativo de sus propias reservas;
- reprogramar sus propias citas cuando el flujo lo permita;
- cancelar sus propias citas;
- recibir información de conexión de sus citas confirmadas.

No puede:
- ver citas de otros pacientes;
- consultar datos de terceros;
- modificar citas que no le pertenecen.

## Administrativo de agendamiento

Puede:
- revisar todas las solicitudes y pre-reservas del módulo de agendamiento;
- identificar reservas pendientes de pago;
- verificar manualmente el pago;
- confirmar el pago en el sistema;
- revisar citas confirmadas;
- asignar o verificar el médico asociado;
- apoyar reprogramaciones y cancelaciones;
- consultar la agenda necesaria para la operación.

El administrativo no procesa la transacción bancaria: únicamente registra o confirma el resultado que ha sido verificado.

## Médico

Puede:
- consultar las citas que le han sido asignadas;
- conocer la fecha y hora;
- disponer del enlace de videollamada;
- consultar los datos mínimos del usuario necesarios para identificar la cita y preparar la atención.

No debe acceder a citas asignadas a otros médicos salvo que exista una autorización institucional específica.

# Control de acceso

Los permisos deben aplicarse en la base de datos, API o backend.

No es suficiente con pedirle al modelo de IA que “no muestre” información. Una consulta de paciente debe estar técnicamente filtrada por el identificador del usuario autenticado.

# Minimización de datos

El chatbot de agendamiento debe recopilar únicamente la información necesaria para ejecutar su función.

No debe solicitar:
- contraseñas;
- credenciales de Google;
- datos bancarios;
- números de tarjeta;
- información clínica detallada que no sea necesaria para gestionar la agenda.

# Confidencialidad

La información de un paciente no debe mostrarse a otro paciente.

El sistema debe evitar incluir información innecesaria o sensible en:
- mensajes del chatbot;
- títulos de eventos de Calendar;
- correos;
- logs;
- documentos del RAG.
