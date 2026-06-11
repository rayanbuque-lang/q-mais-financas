"use client";

import { useEffect, useRef, forwardRef } from "react";

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value?: number;
  onChange?: (v: number) => void;
}

/**
 * Input monetário brasileiro que não requer vírgula manual.
 * Digitar "1", "2", "3" → "0,01" → "0,12" → "1,23"
 * Backspace remove o último dígito. Delete zera.
 */
export const CurrencyInput = forwardRef<HTMLInputElement, Props>(
  function CurrencyInput({ value = 0, onChange, onFocus, onBlur, ...rest }, forwardedRef) {
    const centavosRef = useRef(Math.round((value ?? 0) * 100));
    const focusedRef = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);

    function fmt(c: number) {
      return (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function setDisplay(c: number) {
      const el = (forwardedRef as React.RefObject<HTMLInputElement>)?.current ?? inputRef.current;
      if (el) el.value = fmt(c);
    }

    // Sync from props when not focused (e.g., form reset or template load)
    useEffect(() => {
      if (!focusedRef.current) {
        const c = Math.round((value ?? 0) * 100);
        centavosRef.current = c;
        setDisplay(c);
      }
    }, [value]);

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        const next = centavosRef.current * 10 + Number(e.key);
        if (next > 99_999_999_99) return;
        centavosRef.current = next;
        setDisplay(next);
        onChange?.(next / 100);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        const next = Math.floor(centavosRef.current / 10);
        centavosRef.current = next;
        setDisplay(next);
        onChange?.(next / 100);
      } else if (e.key === "Delete") {
        e.preventDefault();
        centavosRef.current = 0;
        setDisplay(0);
        onChange?.(0);
      } else if (["Tab", "Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "F5"].includes(e.key)) {
        // Allow navigation/submit keys
      } else {
        e.preventDefault();
      }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      e.preventDefault();
      const text = e.clipboardData.getData("text").replace(/\D/g, "");
      if (!text) return;
      const next = Math.min(Number(text), 99_999_999_99);
      centavosRef.current = next;
      setDisplay(next);
      onChange?.(next / 100);
    }

    return (
      <input
        ref={(el) => {
          inputRef.current = el;
          if (typeof forwardedRef === "function") forwardedRef(el);
          else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
        }}
        type="text"
        inputMode="numeric"
        defaultValue={fmt(centavosRef.current)}
        onChange={() => {}}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={(e) => {
          focusedRef.current = true;
          onFocus?.(e);
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          onBlur?.(e);
        }}
        {...rest}
      />
    );
  }
);
