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
 * Convert an ArrayBuffer into a base64 string.
 * Brevo accepts base64 encoded attachment content.
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
 * Send an email using Brevo Transactional Email API.
 */
async function sendWithBrevo(
	env: MailflareEnv,
	input: SendEmailInput,
	sender: string,
): Promise<string> {
	if (!env.BREVO_API_KEY) {
		throw new Error("BREVO_API_KEY is not configured");
	}

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

	/*
	 * Brevo supports HTML and text content.
	 *
	 * We prefer HTML when available.
	 * Otherwise we send plain text.
	 */
	if (input.html) {
		body.htmlContent = input.html;
	}

	if (input.text) {
		body.textContent = input.text;
	}

	/*
	 * Preserve custom headers where possible.
	 */
	if (input.headers) {
		body.headers = input.headers;
	}

	/*
	 * Brevo attachment format:
	 * {
	 *   name: "file.pdf",
	 *   content: "BASE64..."
	 * }
	 */
	if (input.attachments && input.attachments.length > 0) {
		body.attachment = input.attachments.map((attachment) => ({
			name: attachment.filename,
			content: arrayBufferToBase64(attachment.content),
		}));
	}

	const response = await fetch(
		"https://api.brevo.com/v3/smtp/email",
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"api-key": env.BREVO_API_KEY,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);

	let result: {
		messageId?: string;
		code?: string;
		message?: string;
	};

	try {
		result = (await response.json()) as {
			messageId?: string;
			code?: string;
			message?: string;
		};
	} catch {
		result = {};
	}

	if (!response.ok) {
		throw new Error(
			result.message ||
				result.code ||
				`Brevo email request failed with status ${response.status}`,
		);
	}

	if (!result.messageId) {
		throw new Error(
			"Brevo accepted the request but did not return a messageId",
		);
	}

	return result.messageId;
}

export async function sendEmail(
	env: CloudflareEnv,
	input: SendEmailInput,
): Promise<{ messageId: string }> {
	const db = getDb(env);

	/*
	 * Keep Mailflare's existing sender authorization.
	 */
	const sender = await getAuthorizedSenderAddress(
		env,
		input,
	);

	const attachments = input.attachments ?? [];

	validateAttachments(attachments);

	/*
	 * Save/update the recipient as a contact.
	 */
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

	/*
	 * Save outbound message in Mailflare DB.
	 */
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

	/*
	 * Save attachment metadata/content in R2.
	 */
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

	/*
	 * Create outbound job.
	 */
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
		/*
		 * Brevo is now the outbound email provider.
		 *
		 * This avoids Cloudflare Email Routing's
		 * "destination address is not a verified address"
		 * restriction for the reply flow.
		 */
		const providerMessageId = await sendWithBrevo(
			env as MailflareEnv,
			input,
			sender.fromAddr,
		);

		/*
		 * Mark message as successfully sent.
		 */
		await db
			.update(messages)
			.set({
				status: "sent",
				providerMessageId,
			})
			.where(eq(messages.id, messageId));

		/*
		 * Mark outbound job as successfully sent.
		 */
		await db
			.update(outboundJobs)
			.set({
				status: "sent",
				updatedAt: new Date(),
			})
			.where(eq(outboundJobs.id, jobId));

		/*
		 * Notify Mailflare webhooks.
		 */
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

		/*
		 * Create audit log.
		 */
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

		/*
		 * Mark message as failed.
		 */
		await db
			.update(messages)
			.set({
				status: "failed",
			})
			.where(eq(messages.id, messageId));

		/*
		 * Save error in outbound job.
		 */
		await db
			.update(outboundJobs)
			.set({
				status: "failed",
				error,
				updatedAt: new Date(),
			})
			.where(eq(outboundJobs.id, jobId));

		/*
		 * Notify failure webhook.
		 */
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
