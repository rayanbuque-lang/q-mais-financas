"use client";

type Variant = "default" | "movements" | "accounts" | "categories" | "machines" | "search" | "recurring";

function Illustration({ variant }: { variant: Variant }) {
  const s = { width: 96, height: 96 } as const;
  if (variant === "movements") return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <rect x="8" y="28" width="80" height="52" rx="10" fill="var(--border-subtle)" stroke="var(--border)" strokeWidth="2"/>
      <rect x="8" y="38" width="80" height="10" fill="var(--border)" opacity="0.45"/>
      <rect x="56" y="50" width="24" height="20" rx="6" fill="var(--surface)" stroke="var(--border)" strokeWidth="1.5"/>
      <circle cx="68" cy="60" r="5" fill="var(--border)"/>
      <path d="M22 66V46M15 53l7-7 7 7" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M38 46v20M31 59l7 7 7-7" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (variant === "accounts") return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <rect x="12" y="20" width="72" height="64" rx="8" fill="var(--border-subtle)" stroke="var(--border)" strokeWidth="2"/>
      <rect x="12" y="20" width="72" height="22" rx="8" fill="var(--border)" opacity="0.45"/>
      <line x1="32" y1="20" x2="32" y2="12" stroke="var(--border-strong)" strokeWidth="2.5" strokeLinecap="round"/>
      <line x1="64" y1="20" x2="64" y2="12" stroke="var(--border-strong)" strokeWidth="2.5" strokeLinecap="round"/>
      {[0,1,2,3,4,5,6,7,8,9,10,11].map(i => (
        <rect key={i} x={22 + (i%4)*17} y={52 + Math.floor(i/4)*14} width="10" height="8" rx="2"
          fill={i === 5 ? "var(--amber-muted)" : "var(--border)"}
          stroke={i === 5 ? "var(--amber-border)" : "none"} strokeWidth="1"/>
      ))}
      <path d="M36 56l3 3 6-6" stroke="var(--brand)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
  if (variant === "categories") return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <path d="M12 36v40q0 6 6 6h60q6 0 6-6V44q0-6-6-6H48l-8-12H18q-6 0-6 6z" fill="var(--border-subtle)" stroke="var(--border)" strokeWidth="2"/>
      <rect x="20" y="52" width="22" height="16" rx="5" fill="var(--brand-muted)" stroke="var(--brand-border)" strokeWidth="1.5"/>
      <rect x="50" y="52" width="22" height="16" rx="5" fill="var(--amber-muted)" stroke="var(--amber-border)" strokeWidth="1.5"/>
      <circle cx="24" cy="60" r="3" fill="var(--brand)"/>
      <circle cx="54" cy="60" r="3" fill="var(--amber)"/>
      <line x1="28" y1="60" x2="39" y2="60" stroke="var(--brand-border)" strokeWidth="1.5"/>
      <line x1="58" y1="60" x2="69" y2="60" stroke="var(--amber-border)" strokeWidth="1.5"/>
    </svg>
  );
  if (variant === "machines") return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <rect x="16" y="20" width="64" height="56" rx="8" fill="var(--border-subtle)" stroke="var(--border)" strokeWidth="2"/>
      <rect x="16" y="20" width="64" height="24" rx="8" fill="var(--border)" opacity="0.4"/>
      <rect x="24" y="30" width="24" height="8" rx="2" fill="var(--surface)" opacity="0.7"/>
      {[0,1,2,3,4,5,6,7,8].map(i => (
        <rect key={i} x={24 + (i%3)*14} y={54 + Math.floor(i/3)*10} width="10" height="7" rx="2" fill="var(--border)"/>
      ))}
    </svg>
  );
  if (variant === "search") return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <circle cx="40" cy="40" r="26" fill="var(--border-subtle)" stroke="var(--border)" strokeWidth="2.5"/>
      <path d="M60 60L84 84" stroke="var(--border-strong)" strokeWidth="4" strokeLinecap="round"/>
      <line x1="28" y1="34" x2="52" y2="34" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round"/>
      <line x1="28" y1="44" x2="45" y2="44" stroke="var(--border)" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
  if (variant === "recurring") return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <path d="M20 48A28 28 0 1 1 76 48" stroke="var(--border-strong)" strokeWidth="3" strokeLinecap="round" fill="none"/>
      <path d="M70 34l6 14-14-2" stroke="var(--border-strong)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <circle cx="48" cy="54" r="14" fill="var(--brand-subtle)" stroke="var(--brand-border)" strokeWidth="2"/>
      <path d="M48 44v2M48 62v2" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round"/>
      <path d="M53 48q0-2-2.5-2h-4Q44 46 44 49q0 3 2.5 3h3q2.5 0 2.5 3t-2.5 3h-4Q43 58 43 56" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round" fill="none"/>
    </svg>
  );
  // default: empty document
  return (
    <svg {...s} viewBox="0 0 96 96" fill="none">
      <rect x="16" y="10" width="64" height="76" rx="8" fill="var(--border-subtle)" stroke="var(--border)" strokeWidth="2"/>
      <path d="M62 10l18 18h-12a6 6 0 0 1-6-6z" fill="var(--border)" stroke="var(--border)" strokeWidth="1"/>
      <rect x="26" y="40" width="44" height="5" rx="2.5" fill="var(--border)"/>
      <rect x="26" y="52" width="34" height="5" rx="2.5" fill="var(--border)"/>
      <rect x="26" y="64" width="38" height="5" rx="2.5" fill="var(--border)"/>
    </svg>
  );
}

interface Props {
  variant?: Variant;
  title: string;
  description?: string;
  action?: { label: string; href?: string; onClick?: () => void };
  secondaryAction?: { label: string; href?: string; onClick?: () => void };
  compact?: boolean;
}

export default function EmptyState({ variant = "default", title, description, action, secondaryAction, compact }: Props) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: compact ? "36px 20px" : "64px 24px", textAlign: "center", gap: 0,
    }}>
      <div style={{ opacity: 0.85, marginBottom: 16 }}>
        <Illustration variant={variant} />
      </div>
      <h3 style={{ fontSize: compact ? 14 : 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>{title}</h3>
      {description && (
        <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 280, lineHeight: 1.55, margin: "6px 0 0" }}>
          {description}
        </p>
      )}
      {(action || secondaryAction) && (
        <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap", justifyContent: "center" }}>
          {action && (action.href ? (
            <a href={action.href} style={{ padding: "9px 22px", background: "var(--brand)", color: "#fff", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
              {action.label}
            </a>
          ) : (
            <button onClick={action.onClick} style={{ padding: "9px 22px", background: "var(--brand)", color: "#fff", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, border: "none", cursor: "pointer" }}>
              {action.label}
            </button>
          ))}
          {secondaryAction && (secondaryAction.href ? (
            <a href={secondaryAction.href} style={{ padding: "9px 22px", background: "var(--hover-bg)", color: "var(--text)", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, textDecoration: "none", border: "1px solid var(--border)" }}>
              {secondaryAction.label}
            </a>
          ) : (
            <button onClick={secondaryAction.onClick} style={{ padding: "9px 22px", background: "var(--hover-bg)", color: "var(--text)", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 600, border: "1px solid var(--border)", cursor: "pointer" }}>
              {secondaryAction.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
