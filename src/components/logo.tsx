export function Logo() {
  return (
    <div className="flex items-center gap-3">
      <div className="bg-gradient-to-br from-emerald-500 to-emerald-700 text-white font-bold text-base rounded-xl w-10 h-10 flex items-center justify-center shadow-md shadow-emerald-200">
        +Q
      </div>
      <div>
        <h1 className="text-lg font-bold text-[var(--color-text)] leading-tight tracking-tight">
          +Q Finanças
        </h1>
        <p className="text-[10px] text-[var(--color-text-muted)] leading-tight tracking-wide uppercase">
          Inteligência financeira
        </p>
      </div>
    </div>
  );
}
