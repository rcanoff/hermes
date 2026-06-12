declare module 'bcryptjs' {
  export function hash(password: string, rounds: number): Promise<string>
  export function compare(password: string, hashValue: string): Promise<boolean>
}
