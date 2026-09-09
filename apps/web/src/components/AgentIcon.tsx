import type { ReactElement, SVGProps } from 'react';

export type AgentIconName =
  | 'layers'
  | 'message'
  | 'arrow'
  | 'shield'
  | 'lock'
  | 'check'
  | 'link'
  | 'error'
  | 'user';

/** Agent 页面使用的线性功能图标，不承载状态文本或品牌标识。 */
export function AgentIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: AgentIconName }): ReactElement {
  const paths: Record<AgentIconName, ReactElement> = {
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8l10-5Z" />
        <path d="m2 12 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    message: (
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
    ),
    arrow: (
      <>
        <path d="M5 12h14M12 5l7 7-7 7" />
      </>
    ),
    shield: (
      <>
        <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    lock: (
      <>
        <rect x="4" y="10" width="16" height="12" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7" />
        <path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" />
      </>
    ),
    error: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2" />
      </>
    ),
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
