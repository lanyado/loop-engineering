import * as z from 'zod';

/** A row id in a route path or query: a positive whole number. */
export const idParam = z.coerce.number().int().positive();
