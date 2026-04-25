import { useEffect, useRef, useState } from "react";
import type { Review } from "../types.js";
import { SeverityBadge } from "./SeverityBadge.js";

interface Props {
	review: Review;
}

/**
 * Sticky group navigation.
 *
 * - Renders one row per group with a severity dot, title, and finding count.
 * - Tracks the section currently in view via IntersectionObserver and animates a left bar to
 *   the active row using CSS transform (translateY) on a single moving indicator.
 */
export function Sidebar({ review }: Props) {
	const groupIds = review.groups.map((g) => g.id);
	const activeId = useScrollSpy(groupIds);
	const activeIndex = activeId ? groupIds.indexOf(activeId) : -1;

	if (review.groups.length === 0) {
		return (
			<aside
				className="hidden md:block w-[260px] shrink-0 px-6 pt-6 sticky top-[64px] h-[calc(100vh-64px)] overflow-y-auto scrollbar-quiet"
				style={{ borderRight: "1px solid var(--color-line)" }}
			>
				<SidebarHeading />
				<p className="mt-4 text-sm italic" style={{ color: "var(--color-ink-3)" }}>
					Waiting for the agent to start carving up the diff…
				</p>
			</aside>
		);
	}

	return (
		<aside
			className="hidden md:block w-[260px] shrink-0 px-4 pt-6 sticky top-[64px] h-[calc(100vh-64px)] overflow-y-auto scrollbar-quiet"
			style={{ borderRight: "1px solid var(--color-line)" }}
		>
			<SidebarHeading />

			<nav className="mt-4 relative">
				<div
					aria-hidden
					className="absolute left-0 top-0 h-7 w-[2px] rounded-full transition-transform"
					style={{
						backgroundColor: "var(--color-accent)",
						transform: `translateY(${Math.max(activeIndex, 0) * 44 + 6}px)`,
						transitionDuration: "260ms",
						transitionTimingFunction: "var(--ease-out-soft)",
						opacity: activeIndex < 0 ? 0 : 1,
					}}
				/>
				<ul className="flex flex-col">
					{review.groups.map((group, idx) => (
						<li key={group.id} style={{ height: 44 }}>
							<a
								href={`#group-${group.id}`}
								className="flex items-center gap-2.5 pl-3 pr-2 py-2 rounded-r text-sm transition-colors"
								style={{
									color: idx === activeIndex ? "var(--color-ink)" : "var(--color-ink-2)",
									fontWeight: idx === activeIndex ? 600 : 500,
								}}
							>
								<SeverityBadge severity={group.severity} variant="dot" />
								<span className="truncate">{group.title}</span>
								<span className="ml-auto text-xs font-mono" style={{ color: "var(--color-ink-4)" }}>
									{group.findingIds.length || ""}
								</span>
							</a>
						</li>
					))}
				</ul>
			</nav>
		</aside>
	);
}

function SidebarHeading() {
	return (
		<h2 className="text-xs uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
			Groups
		</h2>
	);
}

/**
 * Picks the topmost section currently intersecting the viewport. Uses a band offset so the
 * active item changes when the section header crosses ~30% from the top — matches reading
 * intuition better than the default "any pixel intersects".
 */
function useScrollSpy(ids: string[]): string | null {
	const [active, setActive] = useState<string | null>(null);
	const elementsRef = useRef<HTMLElement[]>([]);

	useEffect(() => {
		const elements = ids
			.map((id) => document.getElementById(`group-${id}`))
			.filter((el): el is HTMLElement => el !== null);
		elementsRef.current = elements;
		if (elements.length === 0) {
			setActive(null);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries
					.filter((e) => e.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
				const first = visible[0];
				if (first) {
					setActive(first.target.id.replace(/^group-/, ""));
				}
			},
			{
				// Top band starts just under the sticky header; bottom band leaves room for the
				// reader so the active section feels stable while scrolling.
				rootMargin: "-72px 0px -55% 0px",
				threshold: [0, 1],
			},
		);
		for (const el of elements) observer.observe(el);
		return () => observer.disconnect();
	}, [ids]);

	return active;
}
