/** Transaction scope shared by queue, session and demo agenda writes. */
export interface Connection { query(sql:string,args?:unknown[]):Promise<any[]>; }
export interface UnitOfWork extends Connection {
  readonly driver:string;
  transaction<T>(work:(connection:Connection)=>Promise<T>):Promise<T>;
}
