---
title: "TeleCUS - Operación administrativa del agendamiento"
category: "admin_operations"
audience: ["admin", "system"]
status: "current_implementation"
version: "2026-10-18"
priority: 100
---

# Objetivo

El administrativo de agendamiento supervisa el recorrido de una solicitud desde la pre-reserva hasta la confirmación de la cita.

# Vista mínima requerida

El panel administrativo debe permitir identificar, como mínimo:
- identificador de la reserva;
- paciente;
- fecha y hora solicitadas;
- médico asignado cuando exista;
- estado de la reserva;
- estado del pago;
- evento de Calendar cuando esté confirmado;
- enlace de Meet cuando exista.

# Flujo administrativo actual

1. El paciente solicita un horario, consulta disponibilidad y confirma su pre-reserva.
2. Realiza el pago en el portal externo y puede adjuntar un comprobante privado.
3. El Administrador abre Pagos del panel; allí ve pendientes, datos de la cita y el comprobante.
4. Puede previsualizar el PDF o imagen en la aplicación y contrastar el recaudo institucional.
5. Abre una revisión y confirma la verificación mediante el formulario, sin pasar por el chatbot.
6. La revisión dura diez minutos. Si vence o cambian la cita o el comprobante, se abre una nueva. Este límite no vence la pre-reserva ni es un plazo para pagar.
7. Se registra la operación durable y se completa Calendar. La cita se anuncia como confirmada solo después de confirmar la agenda.
8. El sistema informa al paciente y al médico y procesa el correo.

# Pago pendiente

El administrativo debe poder filtrar las reservas cuyo pago todavía no ha sido verificado.

El sistema no debe asumir que el pago fue exitoso únicamente porque el usuario diga que pagó.

# Confirmación manual

La acción “Confirmar pago” debe estar disponible únicamente para usuarios con permisos administrativos.

Al ejecutarse, debe disparar el proceso de confirmación de agenda.

# Fallos

Si Calendar o Meet fallan después de verificar el pago:
- no se debe informar falsamente al paciente que la cita quedó correctamente creada;
- el sistema debe registrar el error para intervención administrativa;
- debe evitarse la creación duplicada de eventos al reintentar.

# Integración futura con PSE

Cuando exista un módulo PSE, la confirmación manual podrá sustituirse o complementarse con una notificación automática de pago.

El flujo posterior a la verificación del pago debe mantenerse igual, independientemente de si la verificación es manual o automática.

# Gestión del panel

El panel permite buscar y editar pacientes y médicos, preinscribir personas para su primer acceso con correo verificado, gestionar borradores y publicaciones RAG y actualizar el enlace de pago y el número de soporte. Un perfil administrativo no puede conceder rol ADMIN desde esos formularios.

Desactivar o cambiar el rol requiere resolver las citas vigentes. Se conservan el historial y la auditoría. El correo de una identidad existente se conserva; no se inventan cuentas ni contraseñas.

Los borradores RAG no se muestran a usuarios hasta publicar una versión. La audiencia se conserva y los documentos no cambian las reglas ejecutables del sistema. Puede volver a publicarse una versión anterior.

# Soporte humano

El botón Ayuda permite abrir el canal de WhatsApp configurado. No se transmite automáticamente la conversación ni el comprobante. El usuario revisa el mensaje y decide enviarlo. El contacto vigente se toma de la aplicación; no se fija aquí un teléfono.
