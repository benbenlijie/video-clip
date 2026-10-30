import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ children, size = 18, ...props }: IconProps & { children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export const ArrowRight = (props: IconProps) => <Icon {...props}><path d="M5 12h13M13 6l6 6-6 6" /></Icon>;
export const Check = (props: IconProps) => <Icon {...props}><path d="m5 12 4 4L19 6" /></Icon>;
export const ChevronRight = (props: IconProps) => <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>;
export const CircleHelp = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2-2.4 3.3M12 17h.01" /></Icon>;
export const Copy = (props: IconProps) => <Icon {...props}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></Icon>;
export const FileVideo = (props: IconProps) => <Icon {...props}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 18.5zM16 9l4-2v10l-4-2M8 8h4M8 12h3" /></Icon>;
export const Flag = (props: IconProps) => <Icon {...props}><path d="M5 21V4m0 0c4-3 7 3 14 0v9c-7 3-10-3-14 0" /></Icon>;
export const Gauge = (props: IconProps) => <Icon {...props}><path d="M4 16a8 8 0 1 1 16 0" /><path d="m12 12 4-3M7 19h10" /></Icon>;
export const MessageSquareText = (props: IconProps) => <Icon {...props}><path d="M5 5h14v10H9l-4 4zM8 9h8M8 12h5" /></Icon>;
export const Play = (props: IconProps) => <Icon {...props}><path d="m9 6 9 6-9 6z" fill={props.fill ?? "none"} /></Icon>;
export const Plus = (props: IconProps) => <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
export const RotateCcw = (props: IconProps) => <Icon {...props}><path d="M4 10a8 8 0 1 1 2 7" /><path d="M4 4v6h6" /></Icon>;
export const Sparkles = (props: IconProps) => <Icon {...props}><path d="m12 3 1.3 5.7L19 10l-5.7 1.3L12 17l-1.3-5.7L5 10l5.7-1.3zM19 16l.6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6z" /></Icon>;
export const Subtitles = (props: IconProps) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 11h4M13 11h4M7 15h10" /></Icon>;
export const WandSparkles = (props: IconProps) => <Icon {...props}><path d="m15 4 5 5M4 20 17 7M6 4v3M4 6h4M19 15v3M17 17h4" /></Icon>;
export const Film = (props: IconProps) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4" /></Icon>;
