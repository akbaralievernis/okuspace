/** Справочники CRM — совпадают с CHECK-ограничениями миграции 20261020100000_crm. */
export const SOURCES = ['phone', 'walk_in', 'referral', 'social', 'website_trial', 'website_contact', 'import', 'other'] as const;
export const STAGES = ['new', 'contacted', 'trial_booked', 'trial_done', 'offer', 'won', 'lost'] as const;
export const CHANNELS = ['phone', 'whatsapp', 'telegram', 'email', 'sms', 'in_person', 'other'] as const;
export type Stage = (typeof STAGES)[number];
