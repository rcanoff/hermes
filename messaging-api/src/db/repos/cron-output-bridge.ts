import type Database from 'better-sqlite3'

export function isCronOutputDelivered(db: Database.Database, outputPath: string): boolean {
  const row = db
    .prepare(`
      SELECT 1
      FROM cron_output_deliveries
      WHERE output_path = ?
    `)
    .get(outputPath) as { 1: number } | undefined

  return row !== undefined
}

export function markCronOutputDelivered(
  db: Database.Database,
  outputPath: string,
  hermesJobId: string,
): void {
  db.prepare(`
    INSERT INTO cron_output_deliveries (output_path, hermes_job_id)
    VALUES (?, ?)
  `).run(outputPath, hermesJobId)
}