import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const EDGE_FUNCTION_URL =
  "https://nheyevdjomfphlzmsszk.supabase.co/functions/v1/notificacoes-email";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Sem token" }, { status: 401 });

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "master") {
    return NextResponse.json({ error: "Apenas administradores" }, { status: 403 });
  }

  const res = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": process.env.CRON_SECRET ?? "",
    },
  });

  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
