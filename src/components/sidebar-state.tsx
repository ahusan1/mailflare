"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { SidebarProviderProps, SidebarState } from "./sidebar-state-types";

const SidebarContext = createContext<SidebarState>({ minimal: false, toggle: () => undefined });

export function SidebarProvider({ children, expandedWidth = 240 }: SidebarProviderProps) {
	const [minimal, setMinimal] = useState(false);
	const [storageKey, setStorageKey] = useState<string | null>(null);

	useEffect(() => {
		void fetch("/api/auth/me", { cache: "no-store" })
			.then((response) => response.json() as Promise<{ user?: { id?: string } }>)
			.then((data) => {
				if (!data.user?.id) return;
				const key = `mailflare-sidebar-minimal:${data.user.id}`;
				setStorageKey(key);
				setMinimal(localStorage.getItem(key) === "true");
			});
	}, []);

	function toggle() {
		setMinimal((current) => {
			const next = !current;
			if (storageKey) localStorage.setItem(storageKey, String(next));
			return next;
		});
	}

	return (
		<SidebarContext.Provider value={{ minimal, toggle }}>
			<div className="h-full" style={{ "--sidebar-width": `${minimal ? 72 : expandedWidth}px` } as React.CSSProperties}>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

export function useSidebar() {
	return useContext(SidebarContext);
}
