/** Preserve loaded history only when the latest page overlaps it: otherwise a burst
 * can leave unseen notifications between the two pages. Keep the server's cursor
 * so that every missing item remains reachable through "Ver anteriores". */
export function mergeNotificationPage(previous,result,before){
  if(before){
    const existing=new Set(previous.items.map(item=>item.id));
    return {...result,items:[...previous.items,...result.items.filter(item=>!existing.has(item.id))]};
  }
  const existing=new Set(previous.items.map(item=>item.id));
  if(!result.items.some(item=>existing.has(item.id)))return result;
  const oldest=result.items.at(-1).id;
  const older=previous.items.filter(item=>BigInt(item.id)<BigInt(oldest));
  return {...result,items:[...result.items,...older],next_cursor:older.length?previous.next_cursor:result.next_cursor};
}
