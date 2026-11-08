/** @jsxImportSource react */
import { useState } from 'react';

export default function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="command">
      <code>
        <span aria-hidden="true">$ </span>
        {text}
      </code>
      <button aria-label={`Copy ${text}`} onClick={copy} type="button">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
