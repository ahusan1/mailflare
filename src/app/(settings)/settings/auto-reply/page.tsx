import { MailboxAutoReplyForm } from "@/components/settings/mailbox-auto-reply-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function SettingsAutoReplyPage() {
	return (
		<div className="space-y-8 py-4">
			<div>
				<h1 className="text-3xl font-medium text-neutral-900">Auto-reply</h1>
				<p className="mt-1 text-sm text-neutral-500">
					Automatically respond from the selected inbox when you are away or unavailable.
				</p>
			</div>

			<Card className="rounded-3xl border-0 bg-white px-6">
				<CardHeader>
					<CardTitle>Automatic response</CardTitle>
					<CardDescription>Configure the subject and message for the inbox currently selected above.</CardDescription>
				</CardHeader>
				<CardContent className="pb-6">
					<MailboxAutoReplyForm />
				</CardContent>
			</Card>
		</div>
	);
}
