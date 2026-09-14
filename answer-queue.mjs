export function answerQueue(storage,send,onReceipt=()=>{},withLock=fn=>fn(),onDeleted=()=>{}) {
 const key='reisevalg-answer-outbox-v1';let running=null;
 const read=()=>JSON.parse(storage.getItem(key)||'[]');
 const write=q=>storage.setItem(key,JSON.stringify(q));
 const flush=()=>running||(running=Promise.resolve(withLock(async()=>{while(read().length){const item=read()[0];let receipt;try{receipt=await send(item.path,item.body);}catch(e){if(e.status===410){write(read().filter(x=>x.body.deviceId!==item.body.deviceId));storage.removeItem('profile');storage.removeItem('deviceId');onDeleted();}throw e;}if(!receipt?.savedAt||receipt.submissionId!==item.body.submissionId)throw Error('Ingen gyldig lagringskvittering');await onReceipt(item,receipt);const queue=read();if(queue[0]?.body.submissionId!==item.body.submissionId)throw Error('Sendekø endret');write(queue.slice(1));}})).finally(()=>running=null));
 return {pending:()=>read().length,flush,async submit(path,body){const item={path,body:{...body,submissionId:crypto.randomUUID()}};await withLock(()=>write([...read(),item]));await flush();},async deleteWith(remove){await withLock(async()=>{await remove();storage.removeItem(key);});}};
}
