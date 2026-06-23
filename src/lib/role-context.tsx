"use client";

import { createContext, useContext } from "react";

interface RoleContextValue {
  role: string | null;
  isReadOnly: boolean;
}

const RoleContext = createContext<RoleContextValue>({ role: null, isReadOnly: false });

export function RoleProvider({ role, children }: { role: string | null; children: React.ReactNode }) {
  return (
    <RoleContext.Provider value={{ role, isReadOnly: role === "leitura" }}>
      {children}
    </RoleContext.Provider>
  );
}

export function useRole() {
  return useContext(RoleContext);
}
