// Authored before compact-prompt changes; independent paraphrases, not new prompt examples.
module.exports=[
 {id:'H01',family:'privacidad',context:'reason',text:'Me cuesta hablar de ese asunto por escrito',expect:{dialogue_act:['refuse'],reason:null}},
 {id:'H02',family:'salud-con-negacion',context:'reason',text:'Casi no he podido dormir',expect:{intent:['reserve'],reason:'Casi no he podido dormir'}},
 {id:'H03',family:'motivo',context:'reason',text:'Necesito revisión por un malestar general',expect:{intent:['reserve'],reasonContains:['revisión','malestar general']}},
 {id:'H04',family:'duda-paso',context:'doctor',text:'¿Qué cambia dependiendo del profesional que escoja?',expect:{dialogue_act:['ask'],dialogue_target:'doctor'}},
 {id:'H05',family:'ayuda-tarea',context:'doctor',text:'¿Me orientas para escoger al profesional de la consulta?',expect:{notIntent:['support']}},
 {id:'H06',family:'cortesia-peticion',context:'empty',text:'Buen día, vengo a pedir un turno para una consulta',expect:{intent:['reserve']}},
 {id:'H07',family:'fecha-contextual',context:'date',text:'Si tienes espacio, en el lunes más cercano',expect:{date:'2026-10-26'}},
 {id:'H08',family:'fuera-de-tema',context:'reason',text:'¿Me explicas cómo instalar una impresora?',expect:{reason:null,notIntent:['reserve']}}
];
