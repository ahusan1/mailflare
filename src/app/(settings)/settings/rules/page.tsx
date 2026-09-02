import { InboxRules } from "@/components/settings/inbox-rules";

export default function SettingsRulesPage() {
	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-3xl font-medium text-neutral-900">Rules</h1>
				<p className="mt-1 text-sm text-neutral-500">
					Manage routing and filtering rules for the selected mailbox.
				</p>
			</div>
			<div className="rounded-3xl bg-white p-6">
				<InboxRules />
			</div>
		</div>
	);
}
