export const BOT_ICONS = [
  'person',
  'brain',
  'message',
  'map',
  'heart',
  'star',
  'leaf',
  'bolt',
  'moon',
  'sun',
  'briefcase',
  'book',
  'house',
  'calendar',
  'camera',
  'music',
  'globe',
  'wrench',
  'sparkles',
  'bell',
] as const

export const BOT_COLORS = [
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'indigo',
  'gray',
] as const

export const DEFAULT_BOT_ICON: BotIcon = 'message'
export const DEFAULT_BOT_COLOR: BotColor = 'blue'

export type BotIcon = (typeof BOT_ICONS)[number]
export type BotColor = (typeof BOT_COLORS)[number]

const BOT_ICON_SET = new Set<string>(BOT_ICONS)
const BOT_COLOR_SET = new Set<string>(BOT_COLORS)

export function isBotIcon(value: unknown): value is BotIcon {
  return typeof value === 'string' && BOT_ICON_SET.has(value)
}

export function isBotColor(value: unknown): value is BotColor {
  return typeof value === 'string' && BOT_COLOR_SET.has(value)
}

export function normalizeBotIcon(value: unknown): BotIcon {
  return isBotIcon(value) ? value : DEFAULT_BOT_ICON
}
