// @ts-ignore — generated at build time
import { default as nextHandler } from "./.open-next/worker.js";
import {
	processInboundMessage,
	storeRawToR2,
	type InboundQueueMessage,
} from "./src/lib/email/inbound";
import { processOutboundQueue, type OutboundQueueMessage } from "./src/lib/email/send";
import { getDb } from "./src/db";
import { resolveInboundAddress } from "./src/lib/email/routing";
import { isInboundQueueMessage } from "./worker-utils";
import { getUserFromSession } from "./src/lib/auth/session";
import { getSessionTokenFromRequest } from "./src/lib/realtime/utils";
import {
	getAccountForwardingDestination,
	MAILFLARE_FORWARDED_HEADER,
} from "./src/lib/email/account-forwarding";
export { RealtimeHub } from "./src/lib/realtime/hub";
export { DatabaseBackupWorkflow } from "./src/lib/backups/workflow";

export default {
	async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/api/realtime") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
				return new Response("Expected WebSocket upgrade", { status: 426 });
			}

			const user = await getUserFromSession(env, getSessionTokenFromRequest(request));
			if (!user || user.disabled) {
				return new Response("Unauthorized", { status: 401 });
			}

			const hub = env.REALTIME.getByName(user.id);
			return hub.fetch(new Request("https://mailflare-realtime/connect", request));
		}

		return nextHandler.fetch(request, env, ctx);
	},

	async email(message: ForwardableEmailMessage, env: CloudflareEnv, ctx: ExecutionContext) {
		try {
			const decision = await resolveInboundAddress(getDb(env), message.to);
			if (!decision?.mailbox || decision.action !== "store") {
				message.setReject("Unknown recipient");
				return;
			}
			if (message.headers.get(MAILFLARE_FORWARDED_HEADER) !== "1") {
				const forwardingDestination = await getAccountForwardingDestination(env, message.to);
				if (forwardingDestination) {
					try {
						const forwardingHeaders = new Headers();
						forwardingHeaders.set(MAILFLARE_FORWARDED_HEADER, "1");
						await message.forward(forwardingDestination, forwardingHeaders);
					} catch (error) {
						console.error(`Account forwarding failed for ${message.to}`, error);
					}
				}
			}
			const rawR2Key = await storeRawToR2(env, message.from, message.to, message.raw);
			const payload: InboundQueueMessage = {
				from: message.from,
				to: message.to,
				rawR2Key,
				headers: Object.fromEntries(message.headers),
			};
			await env.INBOUND_QUEUE.send(payload);
		} catch (err) {
			console.error("Inbound enqueue failed", err);
			message.setReject("Processing failed");
		}
	},

	async queue(batch: MessageBatch, env: CloudflareEnv): Promise<void> {
		for (const msg of batch.messages) {
			try {
				if (isInboundQueueMessage(msg.body)) {
					await processInboundMessage(env, msg.body);
				} else {
					await processOutboundQueue(env, msg.body as OutboundQueueMessage);
				}
				msg.ack();
			} catch (err) {
				console.error("Queue processing failed", err);
				msg.retry({ delaySeconds: 10 });
			}
		}
	},
} satisfies ExportedHandler<CloudflareEnv>;
