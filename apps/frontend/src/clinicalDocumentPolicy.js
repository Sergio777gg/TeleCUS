/** Registered appointments only; an empty draft never enables clinical attachments. */
export function documentAppointments(items){
 return (Array.isArray(items)?items:[]).filter(a=>!['CANCELLED','COMPLETED'].includes(a.status)&&(a.can_upload===true||Array.isArray(a.documents)&&a.documents.length>0));
}
export function clinicalSelectionError(file){
 if(!file)return '';
 if(!file.size||file.size>5*1024*1024)return 'El archivo debe pesar entre 1 byte y 5 MB.';
 if(!/\.(?:pdf|jpe?g|png)$/i.test(file.name||''))return 'Selecciona un PDF, JPG o PNG. Otros formatos, como HEIC o Word, deben convertirse antes de adjuntarlos.';
 return '';
}
export function clinicalUploadIdentity(){
 const keys=new WeakMap();
 return (appointment,file)=>{let byAppointment=keys.get(file);if(!byAppointment){byAppointment=new Map();keys.set(file,byAppointment);}if(!byAppointment.has(appointment))byAppointment.set(appointment,crypto.randomUUID());return byAppointment.get(appointment);};
}
