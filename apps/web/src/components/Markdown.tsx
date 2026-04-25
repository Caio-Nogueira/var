import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
	/**
	 * Markdown source. Rendered with GFM extensions (tables, strikethrough, task lists).
	 */
	children: string;
	/**
	 * Block spacing density. `comfortable` suits long-form summaries with multiple sections;
	 * `tight` suits inline-comment threads where vertical space is precious.
	 */
	density?: "comfortable" | "tight";
	/**
	 * Soft cap on line length, in CSS units. Defaults to 62ch to match the existing
	 * paragraph-readability target.
	 */
	maxWidth?: string;
	/**
	 * Base font size token for paragraphs. Headings scale relative to this.
	 */
	fontSize?: string;
	className?: string;
}

/**
 * Renders trusted markdown that the agent emits in `summary`, `finding.body`, and inline
 * comment bodies. Component overrides keep typography aligned with the editorial-technical
 * design system instead of falling back to user-agent defaults. Code blocks use the same
 * Plex Mono palette as the diff viewer; inline code gets a paper-tinted chip.
 *
 * The agent emits headings (`## Strengths`, `## Notable Concerns`, …), bold runs, and inline
 * code freely, so even the "tight" density still renders structure — it just compresses the
 * whitespace around blocks.
 */
export function Markdown({
	children,
	density = "comfortable",
	maxWidth = "62ch",
	fontSize,
	className = "",
}: Props) {
	const space = density === "tight"
		? { para: "0.45em", heading: "0.9em", list: "0.4em", item: "0.15em" }
		: { para: "0.85em", heading: "1.35em", list: "0.7em", item: "0.25em" };

	return (
		<div
			className={className}
			style={{
				color: "var(--color-ink)",
				maxWidth,
				fontSize,
				lineHeight: 1.55,
			}}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					h1: ({ children, ...props }) => (
						<h2
							className="text-xl font-semibold tracking-tight"
							style={{
								color: "var(--color-ink)",
								marginTop: space.heading,
								marginBottom: "0.4em",
							}}
							{...props}
						>
							{children}
						</h2>
					),
					h2: ({ children, ...props }) => (
						<h3
							className="text-lg font-semibold tracking-tight"
							style={{
								color: "var(--color-ink)",
								marginTop: space.heading,
								marginBottom: "0.4em",
							}}
							{...props}
						>
							{children}
						</h3>
					),
					h3: ({ children, ...props }) => (
						<h4
							className="text-base font-semibold tracking-tight"
							style={{
								color: "var(--color-ink)",
								marginTop: space.heading,
								marginBottom: "0.35em",
							}}
							{...props}
						>
							{children}
						</h4>
					),
					h4: ({ children, ...props }) => (
						<h5
							className="text-sm font-semibold uppercase tracking-[0.12em]"
							style={{
								color: "var(--color-ink-2)",
								marginTop: space.heading,
								marginBottom: "0.3em",
							}}
							{...props}
						>
							{children}
						</h5>
					),
					h5: ({ children, ...props }) => (
						<h6
							className="text-xs font-semibold uppercase tracking-[0.14em]"
							style={{
								color: "var(--color-ink-3)",
								marginTop: space.heading,
								marginBottom: "0.3em",
							}}
							{...props}
						>
							{children}
						</h6>
					),
					p: ({ children, ...props }) => (
						<p style={{ margin: `${space.para} 0` }} {...props}>
							{children}
						</p>
					),
					ul: ({ children, ...props }) => (
						<ul
							className="list-disc"
							style={{
								margin: `${space.list} 0`,
								paddingLeft: "1.4em",
							}}
							{...props}
						>
							{children}
						</ul>
					),
					ol: ({ children, ...props }) => (
						<ol
							className="list-decimal"
							style={{
								margin: `${space.list} 0`,
								paddingLeft: "1.4em",
							}}
							{...props}
						>
							{children}
						</ol>
					),
					li: ({ children, ...props }) => (
						<li style={{ margin: `${space.item} 0` }} {...props}>
							{children}
						</li>
					),
					a: ({ children, href, ...props }) => (
						<a
							href={href}
							className="underline-offset-2 hover:underline"
							style={{ color: "var(--color-accent)" }}
							target={href?.startsWith("http") ? "_blank" : undefined}
							rel={href?.startsWith("http") ? "noreferrer" : undefined}
							{...props}
						>
							{children}
						</a>
					),
					strong: ({ children, ...props }) => (
						<strong className="font-semibold" style={{ color: "var(--color-ink)" }} {...props}>
							{children}
						</strong>
					),
					em: ({ children, ...props }) => (
						<em className="italic" {...props}>
							{children}
						</em>
					),
					blockquote: ({ children, ...props }) => (
						<blockquote
							className="italic"
							style={{
								borderLeft: "2px solid var(--color-line-strong)",
								color: "var(--color-ink-2)",
								margin: `${space.para} 0`,
								paddingLeft: "0.85em",
							}}
							{...props}
						>
							{children}
						</blockquote>
					),
					hr: ({ ...props }) => (
						<hr
							style={{
								border: 0,
								borderTop: "1px solid var(--color-line)",
								margin: "1.4em 0",
							}}
							{...props}
						/>
					),
					code: ({ children, className: cls, ...props }) => {
						// react-markdown v10 dropped the `inline` prop. Fenced blocks always carry a
						// `language-*` class via remark; bare backtick spans don't. That heuristic also
						// covers fenced blocks without a language hint, which still get rendered inside
						// a <pre> by the markdown AST — see the `pre` override below.
						const isFenced = typeof cls === "string" && cls.startsWith("language-");
						if (isFenced) {
							return (
								<code className={cls} {...props}>
									{children}
								</code>
							);
						}
						return (
							<code
								className="font-mono"
								style={{
									fontSize: "0.875em",
									backgroundColor: "var(--color-surface-2)",
									color: "var(--color-ink)",
									padding: "0.1em 0.35em",
									borderRadius: "3px",
								}}
								{...props}
							>
								{children}
							</code>
						);
					},
					pre: ({ children, ...props }) => (
						<pre
							className="overflow-x-auto font-mono"
							style={{
								fontSize: "0.875em",
								backgroundColor: "var(--color-surface-2)",
								border: "1px solid var(--color-line)",
								borderRadius: "4px",
								padding: "0.75em 0.85em",
								margin: `${space.para} 0`,
								color: "var(--color-ink)",
								lineHeight: 1.5,
							}}
							{...props}
						>
							{children}
						</pre>
					),
					table: ({ children, ...props }) => (
						<div className="overflow-x-auto" style={{ margin: `${space.para} 0` }}>
							<table
								className="text-sm"
								style={{ borderCollapse: "collapse", width: "100%" }}
								{...props}
							>
								{children}
							</table>
						</div>
					),
					th: ({ children, ...props }) => (
						<th
							className="text-left font-semibold"
							style={{
								borderBottom: "1px solid var(--color-line-strong)",
								padding: "0.45em 0.75em",
								color: "var(--color-ink)",
							}}
							{...props}
						>
							{children}
						</th>
					),
					td: ({ children, ...props }) => (
						<td
							style={{
								borderBottom: "1px solid var(--color-line)",
								padding: "0.45em 0.75em",
							}}
							{...props}
						>
							{children}
						</td>
					),
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
