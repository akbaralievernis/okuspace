export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TASK_STATUSES = ['open', 'in_progress', 'submitted', 'done', 'cancelled'] as const;
/** Кому можно поставить задачу (совпадает с app.task_assignable в БД). */
export const ASSIGNABLE_ROLES = ['branch_manager', 'admin', 'sales_manager', 'accountant', 'teacher'] as const;
export const AUDIENCE_ROLES = ['branch_manager', 'admin', 'sales_manager', 'accountant', 'teacher', 'student', 'parent'] as const;
