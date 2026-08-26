import { useState } from "react";

interface Props {
  label: string;
  value: string;
  caption?: string;
}

export function CopyButton({ label, value, caption }: Props) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={caption ? "mc-copy" : "copy-btn"}
      title={copied ? `Copied ${label}` : `Copy ${label}`}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard may be blocked */
        }
      }}
    >
      {caption ? (
        copied ? "Copied" : caption
      ) : copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M6.2 11.4 3.4 8.6l1.1-1.1 1.7 1.7 4.3-4.3 1.1 1.1z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M6 2h7v9h-2V4H6V2zm-3 3h7v9H3V5zm1.2 1.2v6.6h4.6V6.2H4.2z"
          />
        </svg>
      )}
    </button>
  );
}
