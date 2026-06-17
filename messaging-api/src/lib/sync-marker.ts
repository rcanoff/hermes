export const SYNC_MARKER_ORIGIN = '00000000-0000-4000-8000-000000000000'

export function isSyncMarkerOrigin(marker: string | undefined): boolean {
  return marker === undefined || marker === SYNC_MARKER_ORIGIN
}