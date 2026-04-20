import { z } from "zod";

export const guestErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	stack: z.string().optional(),
	issues: z.array(z.unknown()).optional(),
	cause: z.unknown().optional(),
});

export const guestResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), value: z.unknown() }),
	z.object({ ok: z.literal(false), error: guestErrorSchema }),
]);

export const loadResponseSchema = z.object({
	id: z.string().min(1),
	description: z.string(),
	jsonSchema: z.unknown(),
});

export type GuestResult = z.infer<typeof guestResultSchema>;
export type LoadResponse = z.infer<typeof loadResponseSchema>;
