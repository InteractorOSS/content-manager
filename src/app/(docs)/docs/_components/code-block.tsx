// Shared by every page in the (docs) route group — extracted rather than
// redefined per page once a second page (the /docs/api reference) needed the
// identical terminal-style block.
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-sm">
      <code>{children}</code>
    </pre>
  );
}
