```ts
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, outboundJobs } from "@/db/schema";
import { newId } from "@/lib/ids";
import { buildSnippet } from "@/lib/email/parse";
import { dispatchWebhooks } from "@/lib/email/webhooks";
import { upsertContactFromAddress } from "@/lib/contacts/service";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { createAuditLog } from "@/lib/mailboxes/audit";
import {
	storeMessageAttachments,
	validateAttachments,
} from "@/lib/email/attachments";
import type { AttachmentContent } from "@/lib/email/attachment-types";

export type SendEmailInput = {
	userId: string;
	from: string;
	to: string;
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	mailboxId: string;
	attachments?: AttachmentContent[];
};

type MailflareEnv = CloudflareEnv & {
	BREVO_API_KEY?: string;
};

/**
 * Convert ArrayBuffer to base64 for Brevo attachments.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";

	const chunkSize = 0x8000;

	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(
			i,
			Math.min(i + chunkSize, bytes.length),
		);

		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

/**
 * Send email through Brevo.
 *
 * Brevo does not require the recipient to be individually verified.
 * The sender/domain must be verified in Brevo.
 */
async function sendWithBrevo(
	env: MailflareEnv,
	input: SendEmailInput,
	sender: string,
): Promise<string> {
	if (!env.BREVO_API_KEY) {
		throw new Error("BREVO_API_KEY is not configured");
	}

	const attachments = input.attachments ?? [];

	const body: Record<string, unknown> = {
		sender: {
			email: sender,
		},
		to: [
			{
				email: input.to,
			},
		],
		subject: input.subject,
	};

	if (input.html) {
		body.htmlContent = input.html;
	}

	if (input.text) {
		body.textContent = input.text;
	}

	if (input.headers) {
		body.headers = input.headers;
	}

	if (attachments.length > 0) {
		body.attachment = attachments.map((attachment) => ({
			name: attachment.filename,
			content: arrayBufferToBase64(attachment.content),
		}));
	}

	const response = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: {
			accept: "application/json",
			"api-key": env.BREVO_API_KEY,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const result = (await response.json()) as {
		messageId?: string;
		code?: string;
		message?: string;
	};

	if (!response.ok) {
		throw new Error(
			result.message ||
				result.code ||
				`Brevo email request failed with status ${response.status}`,
		);
	}

	if (!result.messageId) {
		throw new Error("Brevo did not return a messageId");
	}

	return result.messageId;
}

/**
 * Existing Cloudflare Email Service sender.
 *
 * This remains as a fallback so your existing Cloudflare setup
 * continues to work if Brevo is unavailable.
 */
async function sendWithCloudflare(
	env: CloudflareEnv,
	input: SendEmailInput,
	sender: string,
): Promise<string> {
	const attachments = input.attachments ?? [];

	const response = await env.EMAIL.send({
		from: sender,
		to: input.to,
		subject: input.subject,
		headers: input.headers,
		html: input.html,
		text: input.text,

		attachments: attachments.map((attachment) =>
			attachment.disposition === "inline" && attachment.contentId
				? {
						filename: attachment.filename,
						type: attachment.type,
						content: attachment.content,
						disposition: "inline" as const,
						contentId: attachment.contentId,
					}
				: {
						filename: attachment.filename,
						type: attachment.type,
						content: attachment.content,
						disposition: "attachment" as const,
					},
		),
	});

	return response.messageId;
}

export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
): Promise<{ messageId: string }> {
	const db = getDb(env);

	const sender = await getAuthorizedSenderAddress(env, input);

	const attachments = input.attachments ?? [];

	validateAttachments(attachments);

	await upsertContactFromAddress(env, {
		userId: input.userId,
		address: input.to,
		source: "outbound",
	});

	const messageId = newId("msg");

	const snippet = buildSnippet(
		input.text ?? null,
		input.html ?? null,
	);

	await db.insert(messages).values({
		id: messageId,
		userId: input.userId,
		mailboxId: sender.mailboxId,
		direction: "outbound",
		fromAddr: sender.fromAddr,
		toAddr: input.to,
		subject: input.subject,
		snippet,
		textBody: input.text ?? null,
		htmlBody: input.html ?? null,
		status: "queued",
	});

	try {
		await storeMessageAttachments(
			env,
			messageId,
			attachments,
		);
	} catch (error) {
		await db
			.delete(messages)
			.where(eq(messages.id, messageId));

		throw error;
	}

	const jobId = newId("job");

	await db.insert(outboundJobs).values({
		id: jobId,
		userId: input.userId,
		messageId,
		status: "queued",
		payload: JSON.stringify({
			...input,
			from: sender.fromAddr,
			mailboxId: sender.mailboxId,
			attachments: attachments.map(
				({ content: _content, ...attachment }) =>
					attachment,
			),
		}),
	});

	try {
		let providerMessageId: string;

		/**
		 * Preferred provider:
		 * Brevo
		 *
		 * If BREVO_API_KEY is not configured, use Cloudflare.
		 */
		if (env.BREVO_API_KEY) {
			try {
				providerMessageId = await sendWithBrevo(
					env as MailflareEnv,
					input,
					sender.fromAddr,
				);
			} catch (brevoError) {
				console.error(
					"Brevo sending failed, trying Cloudflare Email Service:",
					brevoError,
				);

				providerMessageId = await sendWithCloudflare(
					env,
					input,
					sender.fromAddr,
				);
			}
		} else {
			providerMessageId = await sendWithCloudflare(
				env,
				input,
				sender.fromAddr,
			);
		}

		await db
			.update(messages)
			.set({
				status: "sent",
				providerMessageId,
			})
			.where(eq(messages.id, messageId));

		await db
			.update(outboundJobs)
			.set({
				status: "sent",
				updatedAt: new Date(),
			})
			.where(eq(outboundJobs.id, jobId));

		await dispatchWebhooks(
			env,
			input.userId,
			"message.outbound",
			{
				messageId,
				providerMessageId,
				to: input.to,
			},
		);

		await createAuditLog(env, {
			actorUserId: input.userId,
			mailboxId: sender.mailboxId,
			messageId,
			action: "email.send",
			metadata: {
				to: input.to,
				subject: input.subject,
			},
		});

		return {
			messageId,
		};
	} catch (err) {
		const error =
			err instanceof Error
				? err.message
				: "Send failed";

		await db
			.update(messages)
			.set({
				status: "failed",
			})
			.where(eq(messages.id, messageId));

		await db
			.update(outboundJobs)
			.set({
				status: "failed",
				error,
				updatedAt: new Date(),
			})
			.where(eq(outboundJobs.id, jobId));

		await dispatchWebhooks(
			env,
			input.userId,
			"message.failed",
			{
				messageId,
				error,
			},
		);

		throw err;
	}
}

export type OutboundQueueMessage =
	SendEmailInput & {
		jobId?: string;
	};

export async function processOutboundQueue(
	env: CloudflareEnv,
	payload: OutboundQueueMessage,
): Promise<void> {
	await sendEmail(env, payload);
}
```
