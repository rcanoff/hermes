import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSchema, reconcileRunningRuns } from './schema.js'

let singleton: Database.Database | null = null
let singletonPath: string | null = null

export function getDb(dbPath: string): Database.Database {
  if (dbPath === ':memory:') {
    const db = new Database(':memory:')
    initSchema(db)
    return db
  }

  if (singleton) {
    if (singletonPath !== dbPath) {
      throw new Error(`Database singleton already initialized for ${singletonPath}`)
    }

    return singleton
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  singleton = new Database(dbPath)
  singletonPath = dbPath
  initSchema(singleton)
  reconcileRunningRuns(singleton)
  return singleton
}

export function closeDb(): void {
  singleton?.close()
  singleton = null
  singletonPath = null
}
