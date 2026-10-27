---
title: "TeleCUS - Pago externo, verificación manual y confirmación"
category: "payment_and_confirmation"
audience: ["patient", "admin", "system"]
status: "current_implementation"
version: "2026-10-18"
priority: 100
---

# Responsabilidad del módulo de agendamiento

El módulo de TeleCUS **no procesa directamente el pago**.

El pago es responsabilidad de un sistema externo. La arquitectura debe permitir que posteriormente un sistema PSE desarrollado por otro equipo se integre al flujo, pero esa integración automática no forma parte de la versión actual.

# Flujo actual de pago

1. El paciente confirma una pre-reserva. La aplicación muestra el siguiente paso de pago para esa cita.
2. Abre el portal externo desde la aplicación y realiza allí el pago.
3. Adjunta PDF, JPG o PNG de hasta 5 MB. Puede verlo antes de enviarlo y revisar el archivo recibido dentro de TeleCUS.
4. Recibir el archivo no verifica dinero. El paciente puede retirar un comprobante pendiente para corregirlo; se conserva trazabilidad y no se cancela la pre-reserva.
5. El Administrador abre Pagos en el panel, revisa el comprobante y contrasta el recaudo institucional.
6. Confirma la verificación desde el panel. El asistente de IA no ejecuta este paso.
7. El sistema registra la operación y procesa Calendar. La cita se anuncia como confirmada cuando la agenda confirma el resultado y existe la información de conexión.
8. Se informa al paciente y al médico, y se tramita el correo.

No se debe pedir al paciente pagar nuevamente por un fallo de sincronización de agenda.

# Mensaje recomendado después de la pre-reserva

El chatbot puede comunicar:

> Tu horario ha quedado pre-reservado. Para continuar, realiza el pago mediante el enlace indicado. La cita quedará confirmada únicamente cuando el personal administrativo verifique el pago. Después de la verificación recibirás la confirmación de la cita y la información de conexión.

# Estado del pago

Estados mínimos recomendados:
- `PENDING`: pago pendiente de verificación.
- `VERIFIED`: pago verificado por el administrativo.

Si posteriormente se integra PSE, pueden añadirse otros estados sin modificar el concepto general del flujo.

# Fecha límite de pago y confirmación de operaciones

Los diez minutos corresponden a la revisión de una operación antes de confirmarla. No son el plazo para pagar ni eliminan la pre-reserva o el comprobante. Si la revisión vence, el Administrador abre otra y comprueba los datos actuales.

No hay un plazo financiero fijo de horas o días definido en este corpus ni liberación automática por ese contador. El asistente no inventa vencimientos. Las citas pasadas no admiten la confirmación ordinaria del pago; las incidencias y pagos tardíos deben consultarse con el personal administrativo.

# Enlace de pago

El corpus no contiene una URL de pago definitiva. El chatbot solo debe utilizar el enlace configurado por el sistema. Nunca debe inventar una URL de pago.

# Futuro PSE

La integración futura puede funcionar mediante API o webhook. El sistema externo de pagos debe poder informar, como mínimo:
- identificador de la pre-reserva o cita;
- estado del pago;
- referencia de la transacción cuando exista.

El chatbot no necesita conocer cómo se procesa internamente la transacción.
