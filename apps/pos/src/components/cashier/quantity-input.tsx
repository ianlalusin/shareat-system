
"use client";

import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface QuantityInputProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  disabled?: boolean;
  allowDecimal?: boolean;
}

// Helper to format the number for display, removing trailing zeros
function formatDisplay(num: number, allowDecimal: boolean): string {
    if (!allowDecimal) {
        return String(Math.round(num));
    }
    // Convert to a string with a reasonable number of decimals, then remove trailing zeros.
    // toFixed(4) handles most cases; .replace removes .0000 and trailing zeros from decimals like 2.5000 -> 2.5
    return num.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1');
}


export function QuantityInput({ value, onChange, className, disabled, allowDecimal = false }: QuantityInputProps) {
  const [displayValue, setDisplayValue] = useState(formatDisplay(value, allowDecimal));
  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Update display value when the external value prop changes,
    // but only if the input is not currently focused to avoid interrupting user input.
    if (document.activeElement !== inputRef.current) {
        setDisplayValue(formatDisplay(value, allowDecimal));
    }
  }, [value, allowDecimal]);

  const handleFocus = () => {
    if (parseFloat(displayValue) === 0) {
      setDisplayValue("");
    }
  };

  const handleBlur = () => {
    let numericValue = allowDecimal ? parseFloat(displayValue) : parseInt(displayValue, 10);
    if (isNaN(numericValue) || displayValue.trim() === "") {
      numericValue = 0;
    }
    setDisplayValue(formatDisplay(numericValue, allowDecimal));
    onChange(numericValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    const regex = allowDecimal ? /^\d*\.?\d*$/ : /^\d*$/;
    if (regex.test(rawValue)) {
      setDisplayValue(rawValue);
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const numericValue = allowDecimal ? parseFloat(displayValue) : parseInt(displayValue, 10);
    if (!isNaN(numericValue)) {
      onChange(numericValue);
    }
  };

  return (
    <Input
      ref={inputRef}
      type="text"
      inputMode={allowDecimal ? "decimal" : "numeric"}
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyUp={handleKeyUp}
      className={cn("h-9", className)}
      disabled={disabled}
    />
  );
}
