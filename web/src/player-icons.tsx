export function CompatibilityPlaybackGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9V8a3 3 0 0 1 3-3h13m-3-3 3 3-3 3" />
      <path d="M20 15v1a3 3 0 0 1-3 3H4m3-3-3 3 3 3" />
      <path d="m10 8.5 5.5 3.5-5.5 3.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}


export function SkipSecondsGlyph({ forward = false }: { forward?: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform={forward ? "translate(24 0) scale(-1 1)" : undefined}>
        <path d="M3.3 7.8a9.5 9.5 0 1 1-.7 7.2" />
        <path d="M3 3.5V8h4.5" />
      </g>
      <path
        d="M14.2 8.2h-4.1l-.4 3.6c.6-.5 1.2-.7 2-.7 1.6 0 2.7.9 2.7 2.4s-1.1 2.5-2.6 2.5c-1 0-1.8-.4-2.2-1.1"
        strokeWidth="1.5"
      />
    </svg>
  );
}
