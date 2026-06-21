export const STATUSES = ['backlog', 'plan', 'in-progress', 'review', 'done']

export const STATUS_LABELS = {
  'backlog': 'Backlog',
  'plan': 'Plan',
  'in-progress': 'In Progress',
  'review': 'Review',
  'done': 'Done',
}

export const PRIORITIES = ['urgent', 'high', 'normal', 'low']

export const PRIORITY_LABELS = {
  'urgent': 'Urgent',
  'high': 'High',
  'normal': 'Normal',
  'low': 'Low',
}

export const PRIORITY_WEIGHT = { urgent: 4, high: 3, normal: 2, low: 1 }

export const LABEL_COLORS = ['gray', 'green', 'yellow', 'blue', 'purple', 'red', 'orange']

export const LABEL_COLOR_VALUES = {
  gray: '#8a8b90',
  green: '#4ec28b',
  yellow: '#f5c400',
  blue: '#5f6edb',
  purple: '#7b83e7',
  red: '#ff5d68',
  orange: '#e8853d',
}

export const STATUS_ALIAS = { todo: 'backlog' }
export const PRIORITY_ALIAS = { critical: 'urgent', medium: 'normal', none: 'normal' }

export const LIST_GROUP_ORDER = ['plan', 'backlog', 'in-progress', 'review', 'done']
