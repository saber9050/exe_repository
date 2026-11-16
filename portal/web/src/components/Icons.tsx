import type { Os } from '../lib/api';

type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function IconSearch({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function IconDownload({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function IconCopy({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}

export function IconClose({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconWindows({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M3 5.5 10.5 4.4v7.1H3V5.5Zm0 13 7.5 1.1v-7H3v5.9Zm8.6 1.3L21 21V12.4h-9.4v7.4Zm0-15.6v7.3H21V3l-9.4 1.2Z" />
    </svg>
  );
}

export function IconApple({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z" />
    </svg>
  );
}

export function IconLinux({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      className={className}
      aria-hidden
    >
      <path d="M12 1.6c-2.25 0-4 2-4 4.35 0 1.2.3 2.3.3 3.3 0 .95-.6 1.85-1.3 2.85-1 1.4-1.9 3-1.9 4.75 0 1.35.6 2.4 1.6 2.9-.1.6 0 1.15.4 1.65.7.75 1.95 1.15 3 1.25.6.06 1.3.06 1.9.06s1.3 0 1.9-.06c1.05-.1 2.3-.5 3-1.25.4-.5.5-1.05.4-1.65 1-.5 1.6-1.55 1.6-2.9 0-1.75-.9-3.35-1.9-4.75-.7-1-1.3-1.9-1.3-2.85 0-1 .3-2.1.3-3.3 0-2.35-1.75-4.35-4-4.35Zm-1.65 3.1c.55 0 1 .75 1 1.6s-.45 1.6-1 1.6-1-.75-1-1.6.45-1.6 1-1.6Zm3.3 0c.55 0 1 .75 1 1.6s-.45 1.6-1 1.6-1-.75-1-1.6.45-1.6 1-1.6Z" />
    </svg>
  );
}

export function IconPlatform({ os, size = 15 }: { os: Os; size?: number }) {
  if (os === 'macos') return <IconApple size={size - 1} />;
  if (os === 'linux') return <IconLinux size={size} />;
  return <IconWindows size={size} />;
}

export function IconPackage({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" />
      <path d="M3 7.5 12 12l9-4.5" />
      <path d="M12 12v9" />
    </svg>
  );
}

export function IconChevron({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconShield({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3 5 6v5.5c0 4.3 2.9 7.6 7 9.5 4.1-1.9 7-5.2 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
